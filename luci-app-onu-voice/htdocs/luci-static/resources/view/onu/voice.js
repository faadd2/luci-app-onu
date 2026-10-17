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
 * 当前：数据通路配置 + IMS 可达性检测 + 账号参考
 * 待办：SLIC 驱动移植（见 voice-port-plan.md），之后此页接入 SIP 注册管理
 */

var IMS_PROXIES = ['10.203.255.17', '10.203.255.1'];

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/sbin/ifstatus', ['voip']), '{}');
	},

	render: function() {
		var m = new form.Map('network', '语音设置',
			'语音数据通路（北京联通 IMS VLAN 3010）。电话口注册（SIP）功能待 SLIC 驱动移植完成后提供。');
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

		var a = new form.Map('onu', 'IMS 账号（SIP 注册）',
			'填写运营商 IMS 语音账号（从原光猫备份提取或咨询运营商），供 SIP 客户端注册使用。账号保存在本机配置中，不会进入固件。');
		a.readonly = !L.hasViewPermission();

		var ims = a.section(form.NamedSection, 'ims', 'onu_ims', '账号参数');
		ims.addremove = false;

		o = ims.option(form.Value, 'phone', '电话号码');
		o.placeholder = '+86XXXXXXXXXXX';

		o = ims.option(form.Value, 'sip_account', 'SIP 账号');
		o.placeholder = '+86XXXXXXXXXXX@bj.ims.chinaunicom.cn';

		o = ims.option(form.Value, 'sip_password', 'SIP 密码');
		o.password = true;

		o = ims.option(form.Value, 'proxy', '代理地址');
		o.placeholder = '10.203.255.17 10.203.255.1';
		o.description = '主/备 SIP 代理 IP，空格分隔，端口默认 5060';

		o = ims.option(form.Value, 'reg_period', '注册周期（秒）');
		o.datatype = 'uinteger';
		o.default = '1800';

		o = ims.option(form.Value, 'media_ports', '媒体端口范围');
		o.default = '9000-9010';
		o.description = 'RTP 媒体端口，DTMF 走 RFC2833';

		return m.render().then(function(mapNode) {
			return a.render().then(function(imsNode) {
				return E('div', { 'class': 'cbi-map onu-scope' }, [
					mapNode,
					this.pingBox,
					imsNode
				]);
			}.bind(this));
		}.bind(this));
	},

	pingIms: function() {
		var box = document.getElementById('onu-voice-ping-result');
		dom.content(box, E('p', {}, '检测中…'));
		var jobs = IMS_PROXIES.map(function(ip) {
			return L.resolveDefault(fs.exec_direct('/bin/ping', ['-c', '3', '-W', '2', ip]), null)
				.then(function(text) {
					var m = /(\d+) packets received/.exec(text || '');
					var ms = /= ([\d.]+)\//.exec(text || '');
					return { ip: ip, ok: m && Number(m[1]) > 0, avg: ms ? ms[1] : '-' };
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

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
