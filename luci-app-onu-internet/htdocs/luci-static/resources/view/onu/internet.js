'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';
'require view';
'require view.onu.tabs as tabs';
'require onu.vlan as onuvlan';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css') + '?v=3';
	document.head.appendChild(_onuCss);
}

/*
 * 上网业务模块（通用：PPPoE/DHCP over pon0.<vlan>）
 * VLAN 编辑走 onu.vlan 共享模块（四连接同一模式）
 */

/* uci.apply 安全封装：无改动时 ubus 返回 NO_DATA（uci/apply failed: 无已接收数据），
 * 这是正常空操作，不应中断保存链（LuCI 26 实证） */
function applyUci() {
	return uci.apply().catch(function(err) {
		if (err && /NO_DATA|无已接收数据/.test(String(err.message)))
			return null;
		throw err;
	});
}

/*
 * B11 桥接模式辅助（2026-10-29 S1）
 * 纯桥透传：ONU 本机不拨号（wan.proto=none + 自定义 mode='bridge' 标记），
 * 新增 br-wan（pon0.<vlan> + lan2/3/4）代打业务 tag，br-lan 缩到 lan1(2.5G) 保管理面。
 * 全部走 uci.apply + ubus network reload（现页「仅重载」路径），无 restart/不碰 eth0。
 */

function isBridgeMode() {
	return uci.get('network', 'wan', 'mode') === 'bridge';
}

function parseVid(device) {
	var m = /^(pon0)\.(\d{1,4})$/.exec(device || '');
	return m ? m[2] : '';
}

function findDevSec(name) {
	var id = null;
	uci.sections('network', 'device', function(sec) {
		if (sec.name === name) id = sec['.name'];
	});
	return id;
}

/* 进入桥接：mode 标记 + br-wan 段（继承原 pon0_<vid> MAC，OLT 侧绑定不破）+ br-lan 缩口 */
function applyBridgeUci(vid) {
	var devName = 'pon0.' + vid;
	uci.set('network', 'wan', 'proto', 'none');
	uci.set('network', 'wan', 'mode', 'bridge');

	var macSec = findDevSec(devName) || findDevSec(uci.get('network', 'wan', 'device') || '');
	var mac = macSec ? uci.get('network', macSec, 'macaddr') : null;

	if (!uci.get('network', 'br_wan'))
		uci.add('network', 'device', 'br_wan');
	uci.set('network', 'br_wan', 'type', 'bridge');
	uci.set('network', 'br_wan', 'name', 'br-wan');
	uci.set('network', 'br_wan', 'ports', [devName, 'lan2', 'lan3', 'lan4']);
	if (mac) uci.set('network', 'br_wan', 'macaddr', mac);

	var brlan = findDevSec('br-lan');
	if (brlan) uci.set('network', brlan, 'ports', ['lan1']);
}

/* 退出桥接：清 mode/br_wan，br-lan 恢复 lan1-4（账号等字段留在 uci，免重填） */
function removeBridgeUci() {
	/* 注意：本机 LuCI 新版 uci.js 的 remove(conf,sid) 只收两参、删整段；
	 * 删单个 option 必须用 unset（10-30 实机事故：remove 传三参把 wan 整段删没） */
	uci.unset('network', 'wan', 'mode');
	if (uci.get('network', 'br_wan'))
		uci.remove('network', 'br_wan');
	var brlan = findDevSec('br-lan');
	if (brlan) uci.set('network', brlan, 'ports', ['lan1', 'lan2', 'lan3', 'lan4']);
}

/* cfg-bak 惯例（同目标不覆盖，带时间戳）；失败不阻断保存链 */
function cfgBak(tag) {
	var d = new Date();
	function pad(n) { return (n < 10 ? '0' : '') + n; }
	var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
		'-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
	/* /bin/cp 不在 rpcd ACL 白名单（包内仅 /bin/sh -c * 通配），必须经 sh -c 执行；
	 * 备份失败必须向调用方抛错中断切换（安全默认）——不得静默吞错继续切换
	 * （10-30 实证：静默 catch 致切换后无备份文件，回退兜底缺失） */
	var dst = '/etc/config/network.bak-' + tag + '-' + stamp;
	return fs.exec_direct('/bin/sh', ['-c', 'cp /etc/config/network ' + dst])
		.then(function() { return dst; });
}

/*
 * netifd reload 不新建 device 段（10-30 双对照实验实证：bridge/8021q 新建段 reload 后均不出现；
 * network.device ubus 仅有 status/set_state 等，无 setup/add）——新增 br-wan 必须由页面在 reload 后
 * 用 ip 命令显式创建（设备实测 ip link add/enslave/del 全支持）。
 * uci 里仍保留 br_wan 段：冷启动（重启）时 netifd 会按配置建桥，保证重启后桥接态持久。
 */
function bridgeUpCmd(vid, mac) {
	var dev = 'pon0.' + vid;
	var c = 'ip link add name br-wan type bridge 2>/dev/null; ';
	if (mac)
		c += 'ip link set dev br-wan address ' + mac + '; ';
	c += 'ip link set dev ' + dev + ' master br-wan; ';
	c += 'ip link set dev lan2 master br-wan; ip link set dev lan3 master br-wan; ';
	c += 'ip link set dev lan4 master br-wan; ';
	c += 'ip link set dev lan2 up; ip link set dev lan3 up; ip link set dev lan4 up; ';
	c += 'ip link set dev br-wan up';
	return c;
}

/* 退出桥接：reload 恢复 br-lan 端口（既有 device 变更 reload 生效，实证）后拆手动桥，再 reload 一次
 * 让 wan(pppoe) 拿到释放后的 pon0.<vid>（第一次 reload 时 pon0.<vid> 还在 br-wan 里，必须二次 reload） */
function bridgeDownCmd() {
	return 'ip link set dev br-wan down 2>/dev/null; ip link del br-wan 2>/dev/null; true';
}

/* netifd reload 是异步执行：立即跟进 ip 命令会与落定的 reload 竞态——
 * 13:17 实证 ip 建桥后 1 秒被迟到的 reload 抢回 pon0.3961 并拆桥。
 * 故 reload 与 ip 命令之间必须等落定（sleep 经 sh -c 白名单执行）。
 * 用户 10-30 13:17 批准新增此步骤。 */
function netifdSettle() {
	return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c', 'sleep 2.5; true']), '');
}

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['wan']), '{}');
	},

	render: function(ifstatusText) {
		var m = new form.Map('network', '上网设置',
			'配置 ONU 本机拨号（PPPoE）或 DHCP 上网。VLAN ID 为运营商上网业务 VLAN（北京联通 3961）。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'wan', 'interface', 'WAN 接口');
		s.addremove = false;

		var en = s.option(form.Flag, '_enable', '启用上网线路');
		en.cfgvalue = function() {
			var p = uci.get('network', 'wan', 'proto');
			return ((p && p !== 'none') || isBridgeMode()) ? '1' : '0';
		};
		en.write = function(sectionId, value) {
			if (value !== '1') {
				uci.set('network', 'wan', 'proto', 'none');
				removeBridgeUci();
			}
			else if (!isBridgeMode() &&
				(!uci.get('network', 'wan', 'proto') || uci.get('network', 'wan', 'proto') === 'none')) {
				uci.set('network', 'wan', 'proto', 'pppoe');
			}
		};
		en.remove = function() {};

		var o = null;
		var protoOpt = s.option(form.ListValue, 'proto', '上网方式');
		protoOpt.value('pppoe', 'PPPoE 拨号');
		protoOpt.value('dhcp', 'DHCP 客户端');
		protoOpt.value('bridge', '桥接模式（下游设备拨号）');
		protoOpt.depends('_enable', '1');
		protoOpt.cfgvalue = function() {
			if (isBridgeMode())
				return 'bridge';
			return uci.get('network', 'wan', 'proto') || '';
		};
		/* 虚拟值 'bridge' 映射为 uci proto='none' + mode='bridge' + br_wan/br-lan 端口变更；
		 * VLAN 与桥接同页同时改时，以表单当前值为准拼 br-wan 端口 */
		protoOpt.write = function(sectionId, value) {
			if (value === 'bridge') {
				var vid = parseVid(uci.get('network', 'wan', 'device') || '');
				var fv = selfRef.vlanOpt ? selfRef.vlanOpt.formvalue(sectionId) : '';
				if (fv) vid = String(fv);
				if (!vid) vid = '3961';
				applyBridgeUci(vid);
			}
			else {
				uci.set('network', 'wan', 'proto', value);
				if (isBridgeMode())
					removeBridgeUci();
			}
		};
		protoOpt.remove = function() {};

		o = s.option(form.DummyValue, '_bridge_hint', '桥接说明');
		o.depends('proto', 'bridge');
		o.cfgvalue = function() {
			return 'ONU 变二层桥：本机不再拨号，由接 lan2/lan3/lan4 的下游设备拨号（无需配置 VLAN，' +
				'ONU 代打业务标签）。管理口 lan1（2.5G）保持 192.168.1.1 可达，语音/IPTV/TR-069 不受影响。';
		};

		var vlanOpt = onuvlan.addOption(s, 'wan', '上网 VLAN ID',
			'运营商上网业务 VLAN（北京联通 3961）。修改会重建 pon0 子设备（保留原 MAC）并重新拨号');
		vlanOpt.placeholder = '3961';
		vlanOpt.depends('_enable', '1');

		o = s.option(form.Value, 'username', 'PPPoE 账号');
		o.depends('_enable', '1');
		o.depends('proto', 'pppoe');

		o = s.option(form.Value, 'password', 'PPPoE 密码');
		o.password = true;
		o.depends('_enable', '1');
		o.depends('proto', 'pppoe');

		o = s.option(form.Value, 'mtu', 'MTU');
		o.datatype = 'range(576,1500)';
		o.placeholder = '1492';
		o.depends('_enable', '1');
		o.depends('proto', 'pppoe');

		o = s.option(form.Flag, 'norelease', '断开时不发送 PADT');
		o.description = '保持会话，缩短掉线后重连时间（建议开启）';
		o.depends('_enable', '1');
		o.depends('proto', 'pppoe');

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.default = o.enabled;
		o.depends('_enable', '1');

		var selfRef = this;
		var self = this;
		this.map = m;
		this.protoOpt = protoOpt;
		this.vlanOpt = vlanOpt;
		var statusBox = E('div', { 'class': 'cbi-section' }, [E('h3', {}, '连接状态'), E('p', {}, '加载中…')]);

		this.statusBox = statusBox;
		poll.add(L.bind(this.refreshStatus, this), 5);

		return m.render().then(function(mapNode) {
			self.refreshStatus();
			self.debugLog = E('pre', {
				'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
					'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
			}, '点击「刷新日志」加载。');
			return tabs.render([
				{
					name: '配置', content: E('div', {}, [
						mapNode,
						E('div', { 'class': 'cbi-section' }, [
							E('h3', {}, '操作'),
							E('div', { 'class': 'cbi-page-actions' }, [
								self.reconnectBtn = E('button', {
									'class': 'cbi-button cbi-button-action',
									'click': ui.createHandlerFn(self, 'reconnect')
								}, '保存并重新拨号'),
								E('button', {
									'class': 'cbi-button',
									'click': ui.createHandlerFn(self, 'reloadOnly')
								}, '仅重载网络配置')
							]),
							E('p', { 'class': 'cbi-section-descr' },
								'「保存并重新拨号」会先提交上方表单，再重启 wan 接口；桥接模式下改为应用桥接（仅重载，不拨号）。')
						])
					])
				},
				{
					name: '调试', content: E('div', {}, [
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'refreshDebug', 'log')
							}, '刷新日志（PPPoE/netifd）'),
							' ',
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'refreshDebug', 'ifstatus')
							}, '接口原始状态')
						]),
						self.debugLog
					])
				}
			]).then(function(node) {
				return E('div', { 'class': 'cbi-map onu-scope' }, [self.statusBox, node]);
			});
		});
	},

	refreshDebug: function(kind) {
		var cmd = kind === 'log'
			? ['/bin/sh', '-c', '/sbin/logread -e "ppp|netifd" | tail -40']
			: ['/sbin/ifstatus', 'wan'];
		return fs.exec_direct(cmd[0], cmd.slice(1)).then(function(out) {
			this.debugLog.textContent = (out || '').trim() || '（无输出）';
		}.bind(this));
	},

	refreshStatus: function() {
		var box = this.statusBox;
		if (!box)
			return;
		/* 主按钮文案随「上网方式」表单值联动：桥接=保存并应用桥接 */
		if (this.reconnectBtn) {
			var pv = this.protoOpt ? this.protoOpt.formvalue('wan') : '';
			this.reconnectBtn.textContent = (pv === 'bridge') ? '保存并应用桥接' : '保存并重新拨号';
		}
		/* 桥接模式：替代 ifstatus wan 表，显示 br-wan 实态 + 管理口提示 */
		if (isBridgeMode()) {
			/* /sbin/ip 不在包 ACL 白名单，经 /bin/sh -c *（已授权通配）执行 */
			return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c', 'ip link show br-wan']), '').then(function(out) {
				var rows = [];
				function row(k, v) { rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
					E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v) ])); }
				row('模式', E('span', { 'class': 'label label-info' }, '桥接中——由下游设备拨号'));
				var up = out ? /LOWER_UP|>,UP,/.test(out) : false;
				row('br-wan 状态', out
					? (up ? E('span', { 'class': 'label label-success' }, '已启用')
						: E('span', { 'class': 'label label-warning' }, '存在但未启用'))
					: E('span', { 'class': 'label label-warning' }, '不存在（保存并应用桥接后生成）'));
				row('管理口', 'lan1（2.5G）保持 192.168.1.1 可达');
				dom.content(box, [E('h3', {}, '连接状态'), E('table', { 'class': 'table' }, rows),
					E('pre', { 'style': 'max-height: 10em; overflow: auto; margin: 0.5rem 0 0; ' +
						'padding: 0.5em; background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;' },
						(out || '').trim() || '（无输出）')]);
			});
		}
		return L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['wan']), null).then(function(text) {
			var st = {};
			try { st = JSON.parse(text) || {}; } catch (e) {}
			var rows = [];
			function row(k, v) { rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
				E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v) ])); }
			row('接口状态', st.up
				? E('span', { 'class': 'label label-success' }, '已连接')
				: E('span', { 'class': 'label label-warning' }, '未连接'));
			row('协议', st.proto || '-');
			var addr = (st['ipv4-address'] || []).map(function(a) { return a.address; }).join(', ');
			row('IPv4 地址', addr || '-');
			row('网关', ((st.route || []).map(function(r) { return r.nexthop; })) .filter(function(v, i, arr) { return arr.indexOf(v) === i; }).join(', ') || '-');
			row('运行时间', st.uptime != null ? '%d 秒'.format(st.uptime) : '-');
			row('拨号错误', st.error || '-');
			dom.content(box, [E('h3', {}, '连接状态'), E('table', { 'class': 'table' }, rows)]);
		});
	},

	afterSave: function() {
		return this.reloadOnly();
	},

	/* B11 模式切换确认弹窗：含 lan1 红字警告（ui.showModal 设备 ui.js 已核实存在） */
	confirmModeSwitch: function(entering, confirmFn) {
		var body = entering ? [
			E('p', {}, '即将切换为桥接模式：ONU 本机不再拨号，由接 lan2/lan3/lan4 的下游设备拨号上网（无需配置 VLAN）。'),
			E('p', { 'style': 'color: #d43f3a; font-weight: bold;' },
				'⚠ 切换瞬间 lan2-4 全部断网——操作电脑必须先接到 lan1（2.5G 口）再点确认！'),
			E('p', {}, '管理口 lan1 保持 192.168.1.1 可达；语音/IPTV/TR-069 不受影响。切换前自动备份 network 配置。')
		] : [
			E('p', {}, '即将切回路由模式（ONU 本机拨号），br-lan 恢复 lan1-4，PPPoE 账号等字段保留免重填。'),
			E('p', { 'style': 'color: #d43f3a; font-weight: bold;' },
				'⚠ 端口成员变化瞬间 lan2-4 会话中断——操作电脑请接在 lan1（2.5G 口）上执行。')
		];
		try {
			ui.showModal('确认切换上网模式', body.concat([
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, function() { ui.hideModal(); confirmFn(); })
					}, '确认切换'),
					' ',
					E('button', {
						'class': 'cbi-button',
						'click': ui.createHandlerFn(this, function() { ui.hideModal(); })
					}, '取消')
				])
			]));
		}
		catch (e) {
			if (window.confirm(entering
				? '切换桥接模式：管理电脑必须先接 lan1！确认继续？'
				: '切回路由模式：管理电脑须接 lan1。确认继续？'))
				confirmFn();
		}
	},

	reconnect: function() {
		var self = this;
		var pendingBridge = this.protoOpt ? this.protoOpt.formvalue('wan') === 'bridge' : false;
		var curBridge = isBridgeMode();
		/* 桥接态（进入/退出/已处于）一律走：确认弹窗 → cfg-bak → 保存 → uci.apply → network reload；
		 * 不走 ifdown/ifup（红线规避，wan 已 none 也无拨号可重启） */
		if (pendingBridge || curBridge) {
			this.confirmModeSwitch(pendingBridge, function() {
				var bakPath = null;
				cfgBak(pendingBridge ? 'b11-enter' : 'b11-exit')
					.then(function(dst) { bakPath = dst; return self.map.save(); })
					.then(applyUci)
					.then(function() { return self.reloadOnly(); })
					.then(function() {
						/* netifd reload 不建新 device 段（H-22）：进桥接=reload→等落定→手动建桥；
						 * 退桥接=reload→等落定→拆桥→二次 reload（释放 pon0.<vid> 给 pppoe 重拨）。
						 * 等落定必须：reload 异步，立即发 ip 命令会被迟到 reload 拆除（13:17 实证） */
						if (pendingBridge) {
							var vid = parseVid(uci.get('network', 'wan', 'device') || '') || '3961';
							var mac = uci.get('network', 'br_wan', 'macaddr');
							return netifdSettle().then(function() {
								return L.resolveDefault(
									fs.exec_direct('/bin/sh', ['-c', bridgeUpCmd(vid, mac)]), '');
							});
						}
						else if (curBridge) {
							return netifdSettle()
								.then(function() {
									return L.resolveDefault(
										fs.exec_direct('/bin/sh', ['-c', bridgeDownCmd()]), '');
								})
								.then(function() { return self.reloadOnly(); });
						}
					})
					.then(function() {
						ui.addNotification(null, E('p', {}, pendingBridge
							? '已保存并应用桥接，配置生效需数秒，约 10 秒后自动刷新状态。（备份：%s）'.format(bakPath)
							: '已保存并切回路由模式，约 10 秒后自动刷新状态。（备份：%s）'.format(bakPath)), 'info');
						setTimeout(function() { self.refreshStatus(); }, 10000);
					})
					.catch(function(err) {
						/* 备份失败必须中止切换（此时 map.save 未执行，配置未动） */
						ui.addNotification(null, E('p', {}, bakPath === null
							? '切换已中止：自动备份失败（%s）。未改动任何配置，请手动备份 /etc/config/network 后重试。'
								.format(err.message || err)
							: '操作失败：%s'.format(err.message)), 'danger');
					});
			});
			return;
		}
		return this.map.save()
			.then(applyUci)
			.then(function() {
				return L.resolveDefault(fs.exec_direct('/sbin/ifdown', ['wan']), '');
			})
			.then(function() {
				return L.resolveDefault(fs.exec_direct('/sbin/ifup', ['wan']), '');
			})
			.then(function() {
				ui.addNotification(null, E('p', {}, '已保存并触发重新拨号，配置生效需数秒，约 10 秒后自动刷新状态。'), 'info');
				setTimeout(function() { self.refreshStatus(); }, 10000);
			})
			.catch(function(err) {
				ui.addNotification(null, E('p', {}, '操作失败：%s'.format(err.message)), 'danger');
			});
	},

	reloadOnly: function() {
		return L.resolveDefault(fs.exec_direct('/sbin/ubus', ['call', 'network', 'reload']), '')
			.then(function() {
				ui.addNotification(null, E('p', {}, '网络配置已重载。'), 'info');
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
