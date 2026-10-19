'use strict';
'require dom';
'require form';
'require fs';
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
	_onuCss.href = L.resource('view/onu/onu.css');
	document.head.appendChild(_onuCss);
}

function parseVid(device) {
	var m = /^(?:pon0\.)?(\d{1,4})$/.exec(device || '');
	return m ? m[1] : '';
}

function prefixToMask(p) {
	p = Number(p);
	if (!p || p < 1 || p > 32) return '';
	var mask = [];
	for (var i = 0; i < 4; i++) {
		var n = Math.max(0, Math.min(8, p - i * 8));
		mask.push(256 - Math.pow(2, 8 - n));
	}
	return mask.join('.');
}

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c',
			'apk list --installed 2>/dev/null | grep -E "^(omcproxy|igmpproxy)-" ; echo ---; ' +
			'/etc/init.d/omcproxy enabled 2>/dev/null && echo OMCP_EN || echo OMCP_DIS; ' +
			'pidof omcproxy igmpproxy 2>/dev/null | tr "\\n" " "; echo ===IF===; ' +
			'ifstatus iptv 2>/dev/null'
		]), '');
	},

	render: function(allText) {
		var self = this;
		var parts = String(allText || '').split('===IF===');
		var pkgText = parts[0] || '';
		var ifText = parts[1] || '{}';
		var lease = {};
		try { lease = JSON.parse(ifText) || {}; } catch (e) {}
		var leaseIp = ((lease['ipv4-address'] || [])[0] || {}).address || '';
		var leaseMask = prefixToMask(((lease['ipv4-address'] || [])[0] || {}).mask);
		/* 运营商下发的默认网关/DNS 因 defaultroute/peerdns=0 落在 inactive 段，仍取来回填 */
		var leaseGw = '';
		(((lease.inactive || {}).route) || []).forEach(function(rt) {
			if (!leaseGw && rt.nexthop) leaseGw = rt.nexthop;
		});

		var mc = { omcproxy: false, igmpproxy: false };
		String(pkgText || '').split('\n').forEach(function(l) {
			if (/^omcproxy-/.test(l)) mc.omcproxy = true;
			if (/^igmpproxy-/.test(l)) mc.igmpproxy = true;
		});

		var m = new form.Map('network', 'IPTV 设置',
			'IPTV 数据链路（北京联通 VLAN 3964）、组播代理与机顶盒端口绑定。机顶盒未接时保持链路在线即可。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'iptv', 'interface', 'IPTV 接口');
		s.addremove = false;

		var en = s.option(form.Flag, '_enable', '启用 IPTV 接口');
		en.cfgvalue = function() {
			var p = uci.get('network', 'iptv', 'proto');
			return (p && p !== 'none') ? '1' : '0';
		};
		en.write = function(sectionId, value) {
			if (value !== '1') {
				uci.set('network', 'iptv', 'proto', 'none');
			}
			else if (!uci.get('network', 'iptv', 'proto') || uci.get('network', 'iptv', 'proto') === 'none') {
				uci.set('network', 'iptv', 'proto', 'dhcp');
			}
		};
		en.remove = function() {};

		var o = s.option(form.ListValue, 'proto', '获取方式');
		o.value('dhcp', 'DHCP（运营商自动下发）');
		o.value('static', '静态（手动）');
		o.depends('_enable', '1');

		o = s.option(form.Value, 'ipaddr', 'IP 地址');
		o.datatype = 'ip4addr';
		o.depends('_enable', '1');
		o.depends('proto', 'static');
		o.cfgvalue = function() { return uci.get('network', 'iptv', 'ipaddr') || leaseIp; };
		o.description = 'DHCP 已获取地址自动填入，切换「静态（手动）」时直接可用';

		o = s.option(form.Value, 'netmask', '子网掩码');
		o.datatype = 'netmask';
		o.depends('_enable', '1');
		o.depends('proto', 'static');
		o.cfgvalue = function() { return uci.get('network', 'iptv', 'netmask') || leaseMask; };

		o = s.option(form.Value, 'gateway', '网关');
		o.datatype = 'ip4addr';
		o.depends('_enable', '1');
		o.depends('proto', 'static');
		o.cfgvalue = function() { return uci.get('network', 'iptv', 'gateway') || leaseGw; };

		o = s.option(form.Value, '_vlan', 'IPTV VLAN ID');
		o.datatype = 'range(1,4094)';
		o.placeholder = '3964';
		o.depends('_enable', '1');
		o.cfgvalue = function() { return parseVid(uci.get('network', 'iptv', 'device')); };
		o.write = function(sectionId, value) {
			var dev = uci.get('network', 'iptv', 'device');
			uci.set('network', 'iptv', 'device', 'pon0.' + value);
			/* 若已绑定机顶盒端口，同步更新 br-iptv 的 uplink 口 */
			var b = findBrIptv();
			if (b) {
				var lan = (uci.get('network', b, 'ports') || []).filter(function(p) {
					return !/^pon0\./.test(p);
				})[0];
				if (lan) uci.set('network', b, 'ports', [lan, 'pon0.' + value]);
			}
		};
		o.remove = function() {};

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.description = 'IPTV 链路不应作为默认网关（保持关闭）';
		o.depends('_enable', '1');

		o = s.option(form.Flag, 'peerdns', '使用运营商 DNS');
		o.description = '保持关闭，避免 IPTV 链路 DNS 污染本机解析';
		o.depends('_enable', '1');

		var o2 = onuvlan.addOption(s, 'iptv', 'IPTV VLAN ID',
			'运营商 IPTV 业务 VLAN（北京联通 3964）。修改会重建 pon0 子设备（保留原 MAC），保存后需重载 IPTV 链路');
		o2.placeholder = '3964';
		o2.depends('_enable', '1');

		o2 = s.option(form.Value, '_mvid', '组播 VLAN');
		o2.datatype = 'range(1,4094)';
		o2.placeholder = '4000';
		o2.depends('_enable', '1');
		o2.description = '组播预留 VLAN（北京联通 4000），在 pon0 上创建 8021q 子设备；留空并保存则删除';
		o2.cfgvalue = function() { return uci.get('network', 'pon0_4000', 'vid'); };
		o2.write = function(sectionId, value) {
			if (!value) {
				uci.remove('network', 'pon0_4000');
				return;
			}
			if (!uci.get('network', 'pon0_4000'))
				uci.add('network', 'device', 'pon0_4000');
			uci.set('network', 'pon0_4000', 'type', '8021q');
			uci.set('network', 'pon0_4000', 'name', 'pon0.' + value);
			uci.set('network', 'pon0_4000', 'ifname', 'pon0');
			uci.set('network', 'pon0_4000', 'vid', value);
		};
		o2.remove = function() {};

		/* ---- 机顶盒端口绑定 ---- */
		function findBrIptv() {
			var id = null;
			uci.sections('network', 'device', function(sec) {
				if (sec.name === 'br-iptv') id = sec['.name'];
			});
			return id;
		}

		o = s.option(form.ListValue, '_bindport', '机顶盒端口绑定',
			'把某个 LAN 口桥接到 IPTV 链路：该口下的机顶盒将直接从运营商 IPTV 网络获取地址（与路由模式二选一）。');
		o.value('', '不绑定（路由模式）');
		['lan1', 'lan2', 'lan3', 'lan4'].forEach(function(p) { o.value(p, p); });
		o.depends('_enable', '1');
		o.cfgvalue = function() {
			var b = findBrIptv();
			if (!b) return '';
			var lan = (uci.get('network', b, 'ports') || []).filter(function(p) {
				return !/^pon0\./.test(p);
			})[0];
			return lan || '';
		};
		o.write = function(sectionId, value) {
			var b = findBrIptv();
			var oldLan = b ? (uci.get('network', b, 'ports') || []).filter(function(p) {
				return !/^pon0\./.test(p);
			})[0] : null;
			var vid = parseVid(uci.get('network', 'iptv', 'device')) || '3964';
			var brlan = uci.get('network', '@device[0]') ? null : null;

			if (!value) {
				if (b) uci.remove('network', b);
				uci.set('network', 'iptv', 'device', 'pon0.' + vid);
				if (oldLan) addPortToBrLan(oldLan);
				return;
			}
			if (!b) b = uci.add('network', 'device');
			uci.set('network', b, 'name', 'br-iptv');
			uci.set('network', b, 'type', 'bridge');
			uci.set('network', b, 'ports', [value, 'pon0.' + vid]);
			uci.set('network', 'iptv', 'device', 'br-iptv');
			if (oldLan && oldLan !== value) addPortToBrLan(oldLan);
			removePortFromBrLan(value);
		};
		o.remove = function() {};

		function findBrLan() {
			var id = null;
			uci.sections('network', 'device', function(sec) {
				if (sec.name === 'br-lan') id = sec['.name'];
			});
			return id;
		}
		function removePortFromBrLan(port) {
			var b = findBrLan();
			if (!b) return;
			var ports = (uci.get('network', b, 'ports') || []).filter(function(p) { return p !== port; });
			uci.set('network', b, 'ports', ports);
		}
		function addPortToBrLan(port) {
			var b = findBrLan();
			if (!b) return;
			var ports = uci.get('network', b, 'ports') || [];
			if (ports.indexOf(port) < 0) uci.set('network', b, 'ports', ports.concat([port]));
		}

		/* ---- 组播代理 ---- */
		this.mcStatus = E('div', { 'class': 'cbi-section' });
		this.renderMcStatus(pkgText);

		this.mcBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '组播代理'),
			E('p', { 'class': 'cbi-section-descr' },
				'机顶盒直插（端口绑定）模式通常不需要组播代理；路由模式/跨网段观看组播节目时需要。omcproxy 为推荐方案。'),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'disabled': mc.omcproxy ? 'disabled' : null,
					'click': ui.createHandlerFn(this, 'installMc', 'omcproxy')
				}, mc.omcproxy ? 'omcproxy 已安装' : '安装 omcproxy'),
				' ',
				E('button', {
					'class': 'cbi-button',
					'disabled': mc.omcproxy ? null : 'disabled',
					'click': ui.createHandlerFn(this, 'toggleMc', 'start')
				}, '启动'),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'disabled': mc.omcproxy ? null : 'disabled',
					'click': ui.createHandlerFn(this, 'toggleMc', 'stop')
				}, '停止')
			]),
			this.mcStatus
		]);

		this.statusBox = E('div', { 'class': 'cbi-section' }, [E('h3', {}, '链路状态'), E('p', {}, '加载中…')]);

		this.debugLog = E('pre', {
			'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
				'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
		}, '点击「刷新日志」加载。');

		return m.render().then(function(mapNode) {
			self.refreshStatus();
			return tabs.render([
				{ name: '配置', content: E('div', {}, [
					mapNode,
					self.mcBox,
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, '操作'),
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button cbi-button-save',
								'click': ui.createHandlerFn(self, 'saveAndReload')
							}, '保存并应用'),
							' ',
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'reloadOnly')
							}, '仅重载网络配置')
						]),
						E('p', { 'class': 'cbi-section-descr' },
							'「保存并应用」先提交上方表单，再重启 IPTV 接口。')
					])
				]) },
				{
					name: '调试', content: E('div', {}, [
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'refreshDebug', 'log')
							}, '刷新日志（network/omcproxy/igmpproxy）'),
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

	renderMcStatus: function(pkgText) {
		var text = String(pkgText || '');
		var lines = text.split('\n');
		var pids = '';
		for (var i = 0; i < lines.length; i++)
			if (lines[i].indexOf('OMCP_') === 0) { pids = (lines[i + 1] || '').trim(); break; }
		var rows = [];
		['omcproxy', 'igmpproxy'].forEach(function(name) {
			var installed = new RegExp('^' + name + '-', 'm').test(text);
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, name),
				E('td', { 'class': 'td left' }, installed
					? E('span', { 'class': 'label label-success' }, '已安装')
					: E('span', { 'class': 'label' }, '未安装')),
				E('td', { 'class': 'td left' }, pids.indexOf(name) >= 0
					? E('span', { 'class': 'label label-success' }, '运行中')
					: E('span', { 'class': 'label' }, '未运行'))
			]));
		});
		dom.content(this.mcStatus, E('table', { 'class': 'table' }, rows));
	},

	installMc: function(name) {
		return fs.exec_direct('/sbin/apk', ['add', name]).then(function(out) {
			ui.addNotification(null, E('p', {}, '%s 安装结果：%s'.format(name, (out || '').trim().slice(-200))), 'info');
			location.reload();
		});
	},

	toggleMc: function(action) {
		return fs.exec_direct('/etc/init.d/omcproxy', [action]).then(function() {
			ui.addNotification(null, E('p', {}, 'omcproxy 已%s。'.format(action === 'start' ? '启动' : '停止')), 'info');
		});
	},

	refreshStatus: function() {
		var box = this.statusBox;
		if (!box) return;
		return L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['iptv']), null).then(function(text) {
			var st = {};
			try { st = JSON.parse(text) || {}; } catch (e) {}
			var rows = [];
			function row(k, v) { rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
				E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v) ])); }
			row('链路状态', st.up
				? E('span', { 'class': 'label label-success' }, '在线')
				: E('span', { 'class': 'label label-warning' }, '离线'));
			row('IPv4 地址', (st['ipv4-address'] || []).map(function(a) { return a.address; }).join(', ') || '-');
			row('运行时间', st.uptime != null ? '%d 秒'.format(st.uptime) : '-');
			var bound = (uci.get('network', 'iptv', 'device') === 'br-iptv');
			row('机顶盒绑定', bound
				? E('span', { 'class': 'label label-info' }, '桥接模式（br-iptv）')
				: E('span', { 'class': 'label' }, '路由模式'));
			dom.content(box, [E('h3', {}, '链路状态'), E('table', { 'class': 'table' }, rows)]);
		});
	},

	refreshDebug: function(kind) {
		var cmd = kind === 'log'
			? ['/bin/sh', '-c', '/sbin/logread -e "netifd|omcproxy|igmpproxy" | tail -40']
			: ['/sbin/ifstatus', 'iptv'];
		return fs.exec_direct(cmd[0], cmd.slice(1)).then(function(out) {
			this.debugLog.textContent = (out || '').trim() || '（无输出）';
		}.bind(this));
	},

	saveAndReload: function() {
		var map = document.querySelector('.cbi-map');
		var self = this;
		return dom.callClassMethod(map, 'save')
			.then(function() { return L.resolveDefault(fs.exec_direct('/sbin/ifdown', ['iptv']), ''); })
			.then(function() { return L.resolveDefault(fs.exec_direct('/sbin/ifup', ['iptv']), ''); })
			.then(function() {
				ui.addNotification(null, E('p', {}, '已保存并重启 IPTV 接口。'), 'info');
				setTimeout(function() { self.refreshStatus(); }, 8000);
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
