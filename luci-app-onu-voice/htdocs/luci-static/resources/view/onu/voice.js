'use strict';
'require dom';
'require form';
'require fs';
'require ui';
'require uci';
'require view';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css');
	document.head.appendChild(_onuCss);
}

/*
 * 语音业务模块（北京联通 IMS）
 * v2：SIP 注册管理（baresip）+ 状态显示 + 调试工具
 * 数据通路（VLAN 3010）沿用 v1 配置；账号保存后一键生成 baresip 配置并重启服务
 */

var IMS_PROXIES = ['10.203.255.17', '10.203.255.1'];

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['voip']), '{}');
	},

	render: function(data) {
		var voipIf = {};
		try { voipIf = JSON.parse(data) || {}; } catch (e) {}

		var m = new form.Map('network', '语音设置',
			'语音数据通路（北京联通 IMS VLAN 3010）。SIP 注册由 baresip 承担，账号在下方填写后点「应用并重启 SIP」。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'voip', 'interface', '语音接口');
		s.addremove = false;

		var o = s.option(form.ListValue, 'proto', '接口状态');
		o.value('static', '静态地址（启用）');
		o.value('none', '停用');

		o = s.option(form.Value, 'ipaddr', 'IP 地址');
		o.datatype = 'ip4addr';
		o.depends('proto', 'static');

		o = s.option(form.Value, 'netmask', '子网掩码');
		o.datatype = 'netmask';
		o.depends('proto', 'static');

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.description = '语音链路不应作为默认网关（保持关闭）';

		var r = m.section(form.NamedSection, 'ims_route', 'route', 'IMS 静态路由');
		r.addremove = false;

		o = r.option(form.Value, 'target', '目标网段');
		o.datatype = 'ip4addr';

		o = r.option(form.Value, 'netmask', '子网掩码');
		o.datatype = 'netmask';

		o = r.option(form.Value, 'gateway', '网关');
		o.datatype = 'ip4addr';

		/* ---- SIP 账号 ---- */
		var a = new form.Map('onu', 'IMS 账号（SIP 注册）',
			'账号从原光猫备份提取。应用后自动生成 baresip 配置（固定源端口 5060 + 完整 SIP ID，北京联通 SBC 强制要求）并重启服务。');
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

		/* ---- 状态区 ---- */
		this.statusBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '语音链路状态'),
			E('div', { 'id': 'onu-voice-status' }, E('p', {}, '加载中…'))
		]);

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

		return m.render().then(function(mapNode) {
			return a.render().then(function(imsNode) {
				return E('div', { 'class': 'cbi-map onu-scope' }, [
					mapNode,
					this.statusBox,
					this.pingBox,
					imsNode,
					E('div', { 'class': 'cbi-page-actions' }, [
						E('button', {
							'class': 'cbi-button cbi-button-save',
							'click': ui.createHandlerFn(this, 'handleSaveAndApply')
						}, '保存并应用 SIP')
					]),
					this.debugBox
				]);
			}.bind(this));
		}.bind(this)).then(function(node) {
			this.refreshStatus();
			return node;
		}.bind(this));
	},

	/* 保存后回调：先持久化 UCI，再生成 baresip 配置并重启 */
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	handleSaveAndApply: function() {
		return uci.save()
			.then(function() { return uci.apply(); })
			.then(function() {
				return fs.exec_direct('/usr/libexec/onu-voice-apply', []).then(function(out) {
					var res = {};
					try { res = JSON.parse(out); } catch (e) { res = { ok: false, msg: out }; }
					ui.addNotification(null, E('p', {}, 'SIP：' + (res.msg || '已应用')), res.ok ? 'info' : 'warning');
					this.refreshStatus();
				}.bind(this));
			}.bind(this));
	},

	refreshStatus: function() {
		var box = document.getElementById('onu-voice-status');
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
					E('td', { 'class': 'td left' },
						badge(st.reg_ok === '1', '已注册', '未注册/未知') )
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, '语音口 IP'),
					E('td', { 'class': 'td left' },
						st.voip_up === '1' ? E('var', {}, st.voip_ip || '-') : E('span', { 'class': 'label label-danger' }, '接口未起'))
				])
			];
			dom.content(box, E('table', { 'class': 'table' }, rows));
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
	}
});
