'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require ui';
'require uci';
'require view';
'require view.onu.tabs as tabs';
'require onu.vlan as onuvlan';
'require onu.phone-loc2 as phoneloc';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css') + '?v=3';
	document.head.appendChild(_onuCss);
}

/*
 * 语音业务模块（北京联通 IMS）
 * v2：SIP 注册管理（baresip）+ 状态显示 + 调试工具
 * 数据通路（VLAN 3010）沿用 v1 配置；账号保存后一键生成 baresip 配置并重启服务
 */

var IMS_PROXIES = ['10.203.255.17', '10.203.255.1'];

/* uci.apply 安全封装：无改动时 ubus 返回 NO_DATA（无已接收数据），正常空操作不中断保存链 */
function applyUci() {
	return uci.apply().catch(function(err) {
		if (err && /NO_DATA|无已接收数据/.test(String(err.message)))
			return null;
		throw err;
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['voip']), '{}'),
			uci.load('onu')
		]);
	},

	render: function(data) {
		var voipIf = {};
		try { voipIf = JSON.parse(data[0]) || {}; } catch (e) {}

		var m = new form.Map('network', '语音设置',
			'语音数据通路（北京联通 IMS VLAN 3010）。SIP 注册由 baresip 承担，账号在下方填写后点「应用并重启 SIP」。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'voip', 'interface', '语音接口');
		s.addremove = false;

		var o = s.option(form.Flag, '_enable', '启用语音接口');
		o.cfgvalue = function() {
			var p = uci.get('network', 'voip', 'proto');
			return (p && p !== 'none') ? '1' : '0';
		};
		o.write = function(sectionId, value) {
			if (value !== '1') {
				uci.set('network', 'voip', 'proto', 'none');
			}
			else if (!uci.get('network', 'voip', 'proto') || uci.get('network', 'voip', 'proto') === 'none') {
				uci.set('network', 'voip', 'proto', 'static');
			}
		};
		o.remove = function() {};

		o = s.option(form.Value, 'ipaddr', 'IP 地址');
		o.datatype = 'ip4addr';
		o.depends('_enable', '1');

		o = s.option(form.Value, 'netmask', '子网掩码');
		o.datatype = 'netmask';
		o.depends('_enable', '1');

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.description = '语音链路不应作为默认网关（保持关闭）';
		o.depends('_enable', '1');

		o = onuvlan.addOption(s, 'voip', '语音 VLAN ID',
			'运营商语音业务 VLAN（北京联通 3010）。修改会重建 pon0 子设备（保留原 MAC），保存后需重新应用 SIP');
		o.placeholder = '3010';
		o.depends('_enable', '1');

		/* ---- IMS 静态路由（独立 Map，渲染在账号参数之后，整体受主开关控制） ---- */
		var r = new form.Map('network', 'IMS 静态路由',
			'IMS 语音代理网段经 voip 接口的静态路由（北京联通：10.203.255.0/24，网关 10.143.218.1）。');
		r.readonly = !L.hasViewPermission();

		var rs = r.section(form.NamedSection, 'ims_route', 'route', 'IMS 静态路由');
		rs.addremove = false;

		o = rs.option(form.Value, 'target', '目标网段');
		o.datatype = 'ip4addr';

		o = rs.option(form.Value, 'netmask', '子网掩码');
		o.datatype = 'netmask';

		o = rs.option(form.Value, 'gateway', '网关');
		o.datatype = 'ip4addr';

		/* ---- SIP 账号 ---- */
		var a = new form.Map('onu', 'IMS 账号（SIP 注册）',
			'账号从原光猫备份提取。应用后自动生成 baresip 配置（完整 SIP ID 为认证名，源端口/代理端口/传输协议见下方参数）并重启服务。');
		a.readonly = !L.hasViewPermission();

		var ims = a.section(form.NamedSection, 'ims', 'onu_ims', '账号参数');
		ims.addremove = false;

		o = ims.option(form.Value, 'phone', '电话号码');
		o.placeholder = '+86XXXXXXXXXXX';

		o = ims.option(form.Value, 'sip_account', 'SIP 账号');
		o.placeholder = '+86XXXXXXXXXXX@bj.ims.chinaunicom.cn';
		o.description = '必须为完整 SIP ID（含 +86 与域名），否则联通 IMS 返回 403';

		o = ims.option(form.Value, 'sip_password', 'SIP 密码');
		o.password = true;

		o = ims.option(form.Value, 'proxy', '代理地址');
		o.placeholder = '10.203.255.17 10.203.255.1';
		o.description = '主/备 SIP 代理 IP，空格分隔，取第一个作为主注册代理，端口固定 5060';

		o = ims.option(form.Value, 'reg_period', '注册周期（秒）');
		o.datatype = 'uinteger';
		o.default = '3600';

		o = ims.option(form.Value, 'sip_port', 'SIP 源端口');
		o.datatype = 'port';
		o.placeholder = '5060';
		o.description = '本机 SIP 监听/源端口。北京联通 SBC 要求固定 5060（随机端口会被静默丢弃）；其他运营商可改。填 0 = 不绑定（随机端口）';

		o = ims.option(form.ListValue, 'transport', 'SIP 传输协议');
		o.value('udp', 'UDP');
		o.value('tcp', 'TCP');
		o.value('tls', 'TLS');
		o.default = 'udp';

		o = ims.option(form.Value, 'reg_port', '代理端口');
		o.datatype = 'port';
		o.placeholder = '5060';
		o.description = '注册代理（registrar）端口，缺省 5060';

		o = ims.option(form.ListValue, 'ptime', '语音包长（ms）');
		o.value('10', '10');
		o.value('20', '20');
		o.value('30', '30');
		o.value('40', '40');
		o.default = '20';

		/* ---- 本机黄页（软话机标签内，与软话机设置放在一起） ---- */
		var pbm = new form.Map('onu', '本机黄页',
			'来电/去电号码匹配后显示姓名（仅保存在本机）。');
		pbm.readonly = !L.hasViewPermission();
		var pbs = pbm.section(form.GridSection, 'phonebook', '黄页条目');
		pbs.anonymous = true;
		pbs.addremove = true;
		pbs.sortable = true;
		o = pbs.option(form.Value, 'number', '号码');
		o.datatype = 'phonedigit';
		o = pbs.option(form.Value, 'name', '姓名');

		/* ---- 状态区 ---- */
		this.statusBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '语音链路状态'),
			E('div', { 'id': 'onu-voice-status' }, E('p', {}, '加载中…'))
		]);
		poll.add(L.bind(this.refreshStatus, this), 5);

		/* ---- IMS 可达性（保留 v1） ---- */
		this.pingBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, 'IMS 可达性'),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'pingIms')
				}, '检测 IMS 代理连通性')
			]),
			E('div', { 'id': 'onu-voice-ping-result' }, E('p', {}, '尚未检测'))
		]);

		/* ---- 调试区 ---- */
		this.debugBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '调试'),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button',
					'click': ui.createHandlerFn(this, 'showLog', ['dmesg'])
				}, '驱动日志（dmesg）'),
				' ',
				E('button', {
					'class': 'cbi-button',
					'click': ui.createHandlerFn(this, 'showLog', ['baresip'])
				}, 'SIP 日志（logread）')
			]),
			E('div', { 'id': 'onu-voice-debug' }, E('p', {}, '点击按钮查看日志'))
		]);

		/* ---- 软话机（baresip ctrl_tcp 桥，信令控制面） ---- */
		this.phoneBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '软话机'),
			E('p', { 'class': 'cbi-section-descr' },
				'通过 baresip 控制接口拨号/接听（信令面）。通话声音需 FXS 话机或后续浏览器音频方案。'),
			E('div', { 'id': 'onu-voice-phone-status' }, E('p', {}, '加载中…')),
			E('div', { 'style': 'margin:0.5em 0' }, [
				E('input', {
					'id': 'onu-voice-phone-num',
					'type': 'text',
					'placeholder': '号码（外地前加 0）',
					'style': 'width:16em;padding:0.4em;font-size:1.1em'
				}),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'phoneDial')
				}, '呼叫'),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'id': 'onu-voice-phone-answer',
					'style': 'display:none',
					'click': ui.createHandlerFn(this, 'phoneAnswer')
				}, '接听'),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-reset',
					'id': 'onu-voice-phone-hangup',
					'style': 'display:none',
					'click': ui.createHandlerFn(this, 'phoneHangup')
				}, '挂断')
			]),
			this.buildKeypad()
		]);
		poll.add(L.bind(this.refreshPhone, this), 3);

		return m.render().then(function(mapNode) {
			return a.render().then(function(imsNode) {
				return r.render().then(function(routeNode) {
					return pbm.render().then(function(pbNode) {
						this.refreshStatus();
						/* 主开关折叠：账号参数与静态路由在另外的 Map，depends 跨 Map 无效，手动隐藏 */
						var enInput = mapNode.querySelector('[data-field$="._enable"] input[type="checkbox"]');
						var applyVis = function() {
							var on = enInput ? enInput.checked : true;
							imsNode.style.display = on ? '' : 'none';
							routeNode.style.display = on ? '' : 'none';
						};
						if (enInput) enInput.addEventListener('change', applyVis);
						applyVis();
						return tabs.render([
							{
								name: '配置', content: E('div', {}, [
									mapNode,
									imsNode,
									routeNode,
									E('div', { 'class': 'cbi-page-actions' }, [
										E('button', {
											'class': 'cbi-button cbi-button-save',
											'click': ui.createHandlerFn(this, 'handleSaveAndApply')
										}, '保存并应用 SIP')
									])
								])
							},
							{ name: '调试', content: this.debugBox },
							{
								name: '软话机', content: E('div', {}, [
									this.phoneBox,
									pbNode,
									E('div', { 'class': 'cbi-page-actions' }, [
										E('button', {
											'class': 'cbi-button cbi-button-save',
											'click': ui.createHandlerFn(this, 'savePhonebook')
										}, '保存黄页')
									])
								])
							}
						]).then(function(node) {
							return E('div', { 'class': 'cbi-map onu-scope' }, [this.statusBox, this.pingBox, node]);
						}.bind(this));
					}.bind(this));
				}.bind(this));
			}.bind(this));
		}.bind(this));
	},

	/* 保存后回调：先持久化 UCI，再生成 baresip 配置并重启 */
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	handleSaveAndApply: function() {
		return uci.save()
			.then(applyUci)
			.then(function() {
				return fs.exec_direct('/usr/libexec/onu-voice-apply', []).then(function(out) {
					var res = {};
					try { res = JSON.parse(out); } catch (e) { res = { ok: false, msg: out }; }
					ui.addNotification(null, E('p', {}, 'SIP：' + (res.msg || '已应用') + (res.ok ? '，配置生效需数秒。' : '')), res.ok ? 'info' : 'warning');
					this.refreshStatus();
				}.bind(this));
			}.bind(this));
	},

	refreshStatus: function() {
		var box = this.statusBox;
		if (!box) return;
		return fs.exec_direct('/usr/libexec/onu-voice-status', []).then(function(out) {
			var st = {};
			try { st = JSON.parse(out); } catch (e) {}
			function badge(ok, okText, badText) {
				return ok ?
					E('span', { 'class': 'label label-success' }, okText) :
					E('span', { 'class': 'label label-danger' }, badText);
			}
			var rows = [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, 'FXS 芯片（SLIC）'),
					E('td', { 'class': 'td left' },
						badge(st.slic_bound === '1', 'Le9642 已识别并绑定', '未绑定' + (st.slic_msg ? '（' + st.slic_msg + '）' : '')))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, '语音内核模块'),
					E('td', { 'class': 'td left' }, badge(Number(st.voice_mods) >= 5, st.voice_mods + '/5 已加载', '仅 ' + st.voice_mods + '/5'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, 'PCM 中断'),
					E('td', { 'class': 'td left' }, badge(st.pcm_irq === '1', '已注册', '未注册'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, 'baresip 进程'),
					E('td', { 'class': 'td left' }, badge(st.baresip_running === '1', '运行中', '未运行'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, 'IMS 注册'),
					E('td', { 'class': 'td left' }, [
						badge(st.reg_ok === '1', '已注册', '未注册/未知'),
						st.reg_ok === '1' && st.reg_phone ? E('span', {}, ['（', E('var', {}, st.reg_phone), '）']) : ''
					])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, '语音口 IP'),
					E('td', { 'class': 'td left' },
						st.voip_up === '1' ? E('var', {}, st.voip_ip || '-') : E('span', { 'class': 'label label-danger' }, '接口未起'))
				])
			];
			dom.content(box, [E('h3', {}, '语音链路状态'), E('table', { 'class': 'table' }, rows)]);
		});
	},

	showLog: function(kind) {
		var box = document.getElementById('onu-voice-debug');
		if (!box) return Promise.resolve();
		dom.content(box, E('p', {}, '加载中…'));
		var cmd = kind === 'dmesg' ?
			['/bin/dmesg'] :
			['/sbin/logread', '-e', 'baresip'];
		return fs.exec_direct(cmd[0], cmd.slice(1)).then(function(out) {
			var lines = (out || '').trim().split('\n').filter(function(l) {
				return kind !== 'dmesg' || /le96|slic|zsi|pcm/i.test(l);
			}).slice(-30);
			dom.content(box, E('pre', {
				'style': 'max-height:20em;overflow:auto;background:#111;color:#ddd;padding:0.5em'
			}, lines.join('\n') || '（无相关日志）'));
		});
	},

	pingIms: function() {
		var box = document.getElementById('onu-voice-ping-result');
		dom.content(box, E('p', {}, '检测中…'));
		var jobs = IMS_PROXIES.map(function(ip) {
			return L.resolveDefault(fs.exec_direct('/bin/ping', ['-c', '3', '-W', '2', ip]), null)
				.then(function(text) {
					var mm = /(\d+) packets received/.exec(text || '');
					var ms = /= ([\d.]+)\//.exec(text || '');
					return { ip: ip, ok: mm && Number(mm[1]) > 0, avg: ms ? ms[1] : '-' };
				});
		});
		return Promise.all(jobs).then(function(results) {
			var rows = results.map(function(r) {
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, E('var', {}, r.ip)),
					E('td', { 'class': 'td left' }, r.ok
						? E('span', { 'class': 'label label-success' }, '可达，平均 %s ms'.format(r.avg))
						: E('span', { 'class': 'label label-danger' }, '不可达'))
				]);
			});
			dom.content(box, E('table', { 'class': 'table' }, rows));
		});
	},

	/* ---------- 软话机 ---------- */

	buildKeypad: function() {
		/* div+CSS Grid 布局（弃 table：LuCI 全局 table 规则与之冲突，详见 docs/软话机键盘设计参考）。
		   标准电话序 3x4，圆形键，数字+字母副标（仿 iOS 拨号盘） */
		var keys = [
			['1', ''], ['2', 'ABC'], ['3', 'DEF'],
			['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
			['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
			['*', ''], ['0', '+'], ['#', '']
		];
		var self = this;
		return E('div', { 'class': 'onu-keypad' },
			keys.map(function(kv) {
				return E('button', {
					'class': 'onu-keypad-key',
					'type': 'button',
					'click': ui.createHandlerFn(self, 'keypadPress', kv[0])
				}, [
					E('span', { 'class': 'onu-keypad-num' }, kv[0]),
					kv[1] ? E('span', { 'class': 'onu-keypad-sub' }, kv[1]) : null
				]);
			}));
	},

	keypadPress: function(k) {
		var el = document.getElementById('onu-voice-phone-num');
		if (el) el.value = (el.value || '') + k;
	},

	phoneCmd: function(args, okMsg) {
		return fs.exec_direct('/usr/libexec/onu-voice-phone', args).then(function(out) {
			var res = {};
			try { res = JSON.parse(out); } catch (e) { res = { response: false, error: out }; }
			if (!res.response) {
				ui.addNotification(null, E('p', {}, '软话机：' + (res.error || '控制接口无响应')), 'warning');
			} else if (res.ok === false) {
				ui.addNotification(null, E('p', {}, '软话机：' + ((res.data || '').trim() || '命令执行失败')), 'warning');
			} else if (okMsg) {
				ui.addNotification(null, E('p', {}, '软话机：' + okMsg), 'info');
			}
			this.refreshPhone();
		}.bind(this));
	},

	savePhonebook: function() {
		return uci.save()
			.then(function() { return uci.apply(); })
			.then(function() {
				ui.addNotification(null, E('p', {}, '黄页已保存'), 'info');
			});
	},

	phoneDial: function() {
		var el = document.getElementById('onu-voice-phone-num');
		var num = el ? (el.value || '').trim() : '';
		if (!num) {
			ui.addNotification(null, E('p', {}, '软话机：请先输入号码'), 'warning');
			return Promise.resolve();
		}
		return this.phoneCmd(['dial', num]);
	},

	phoneAnswer: function() {
		return this.phoneCmd(['answer']);
	},

	phoneHangup: function() {
		return this.phoneCmd(['hangup']);
	},

	/* 轮询 baresip 通话状态：空闲 / 呼出振铃 / 来电振铃 / 通话中
	 * listcalls 文本每通话含 state 与 peer（sip:号码@代理），逐条解析 */
	refreshPhone: function() {
		var box = document.getElementById('onu-voice-phone-status');
		if (!box) return Promise.resolve();
		var answerBtn = document.getElementById('onu-voice-phone-answer');
		var hangupBtn = document.getElementById('onu-voice-phone-hangup');
		return fs.exec_direct('/usr/libexec/onu-voice-phone', ['status']).then(function(out) {
			var res = {};
			try { res = JSON.parse(out); } catch (e) {}
			var txt = (typeof res.data === 'string') ? res.data : '';
			var mm = /Active calls \((\d+)\)/.exec(txt);
			var nCalls = mm ? Number(mm[1]) : (res.response === false ? -1 : 0);
			if (answerBtn) answerBtn.style.display = /INCOMING/i.test(txt) ? '' : 'none';
			if (hangupBtn) hangupBtn.style.display = nCalls > 0 ? '' : 'none';
			if (nCalls < 0) {
				dom.content(box, E('p', {}, 'baresip 控制接口未响应（确认已安装 baresip-mod-ctrl_tcp 并已重启 SIP）'));
				return;
			}
			if (nCalls === 0) {
				this._hadIncoming = false;
				dom.content(box, E('p', {}, '空闲'));
				return;
			}
			/* 提取每通话：state 与对端号码（兼容 sip:user@host 与裸 user@host 两种打印） */
			var calls = [];
			var re = /(INCOMING|OUTGOING|RINGING|ESTABLISHED)/gi;
			var uriRe = /(?:sip|tel):([+0-9][0-9*#+]{4,})/g;
			var states = [];
			var m;
			while ((m = re.exec(txt))) states.push(m[1].toUpperCase());
			var uris = [];
			while ((m = uriRe.exec(txt))) uris.push(m[1] || m[2]);
			/* 状态与 URI 数量可能对不齐（被叫显示名等），以号码列为准对齐 */
			for (var i = 0; i < Math.max(states.length, 1); i++)
				calls.push({ state: states[i] || 'UNKNOWN', num: uris[i] || '' });

			var hasIncoming = states.indexOf('INCOMING') >= 0;
			var hasEst = states.indexOf('ESTABLISHED') >= 0;
			var state = hasEst ? ['通话中', 'label label-success']
				: hasIncoming ? ['来电振铃', 'label label-warning']
				: ['呼叫进行中', 'label label-info'];

			/* 来电：首次检测到时发浏览器桌面通知 */
			if (hasIncoming && !this._hadIncoming) {
				this._hadIncoming = true;
				var caller = uris[0] || '未知号码';
				if ('Notification' in window && Notification.permission === 'granted')
					new Notification('ONU 软话机 — 来电', { body: caller });
				else if ('Notification' in window && Notification.permission === 'default')
					Notification.requestPermission();
			}

			/* 黄页 + 归属地 enrichment */
			/* LuCI 加载器可能直接实例化 baseclass 导出：类则 new，实例则直接用 */
			this._pl = this._pl || (typeof phoneloc === 'function' ? new phoneloc() : phoneloc);
			var pb = {};
			uci.sections('onu', 'phonebook', function(s) {
				if (s.number && s.name)
					pb[String(s.number).replace(/[^\d]/g, '')] = s.name;
			});
			var jobs = calls.map(function(c) {
				var d = String(c.num || '').replace(/[^\d]/g, '');
				c.name = pb[d] || pb[d.substring(d.length - 11)] || '';
				return this._pl.lookup(c.num).then(function(loc) {
					c.loc = loc;
					return c;
				});
			}, this);
			var renderKids = function() {
				var rows = calls.map(function(c) {
					var stMap = {
						'INCOMING': ['来电', 'label label-warning'],
						'OUTGOING': ['呼出', 'label label-info'],
						'RINGING': ['振铃', 'label label-info'],
						'ESTABLISHED': ['通话中', 'label label-success'],
						'UNKNOWN': ['进行中', 'label']
					};
					var st = stMap[c.state] || stMap.UNKNOWN;
					var who = c.name ?
						[c.name, c.loc ? E('span', { 'class': 'label label-info', 'style': 'margin-left:1em' }, c.loc) : '']
						: [E('var', { 'style': 'font-size:1.3em' }, c.num || '-'),
						   c.loc ? E('span', { 'class': 'label label-info', 'style': 'margin-left:1em' }, c.loc) : ''];
					return E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left', 'style': 'white-space:nowrap' }, who),
						E('td', { 'class': 'td left', 'style': 'white-space:nowrap' }, E('span', { 'class': st[1] }, st[0]))
					]);
				});
				/* 总体状态横幅（与每行明细同源：baresip listcalls 汇总） */
				var kids = [
					E('p', {}, E('span', { 'class': state[1] }, state[0])),
					E('table', { 'class': 'table', 'style': 'width:auto;border-collapse:collapse' }, rows)
				];
				if (hasIncoming) {
					kids.push(E('div', { 'class': 'cbi-section', 'style': 'margin-top:0.5em' }, [
						E('p', {}, '来电接听指引：'),
						E('ul', {}, [
							E('li', {}, '点上方「接听」即接通信令；通话声音需 FXS 话机（修复中）或手机软话机。'),
							E('li', {}, '手机接听：LAN 下 Linphone/MicroSIP 按联通参数配置（语音调试页可查 SIP 日志与参数），需先停用本机 baresip——联通单注册互踢。')
						])
					]));
				}
				if (hasEst) {
					kids.push(E('div', { 'class': 'cbi-section', 'style': 'margin-top:0.5em' }, [
						E('p', {}, [
							E('span', { 'class': 'label label-warning' }, '已接通，但当前无音频线路'),
							' 本页面仅接通信令，听不到对方。声音出路：① FXS 话机（修复中）；② 手机 Linphone/MicroSIP（需停用本机 baresip 后由手机注册）。'
						])
					]));
				}
				dom.content(box, kids);
			};
			/* 先立即显示号码/状态，归属地查询异步完成后重绘补上 */
			renderKids();
			return Promise.all(jobs).then(renderKids);
		}.bind(this)).catch(function(err) {
			dom.content(box, E('p', { 'class': 'label label-danger' },
				'状态刷新失败：' + ((err && err.message) || err)));
		});
	}
});
