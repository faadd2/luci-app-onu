'use strict';
'require dom';
'require form';
'require fs';
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

function parseVid(device) {
	var m = /^(pon0)\.(\d{1,4})$/.exec(device || '');
	return m ? m[2] : '';
}

return view.extend({
	render: function() {
		var m = new form.Map('network', 'IPTV 设置',
			'IPTV 数据链路（北京联通 VLAN 3964）与组播预留（VLAN 4000）。机顶盒未接时保持链路在线即可。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'iptv', 'interface', 'IPTV 接口');
		s.addremove = false;

		var o = s.option(form.ListValue, 'proto', '获取方式');
		o.value('dhcp', 'DHCP（运营商自动下发）');
		o.value('none', '停用');

		o = s.option(form.Value, '_vlan', 'IPTV VLAN ID');
		o.datatype = 'range(1,4094)';
		o.placeholder = '3964';
		o.cfgvalue = function() { return parseVid(uci.get('network', 'iptv', 'device')); };
		o.write = function(sectionId, value) {
			uci.set('network', 'iptv', 'device', 'pon0.' + value);
		};
		o.remove = function() {};

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.description = 'IPTV 链路不应作为默认网关（保持关闭）';

		o = s.option(form.Flag, 'peerdns', '使用运营商 DNS');
		o.description = '保持关闭，避免 IPTV 链路 DNS 污染本机解析';

		var o2 = s.option(form.DummyValue, '_mcvlan', '组播 VLAN');
		o2.cfgvalue = function() {
			var dev = uci.get('network', 'pon0_4000');
			return dev ? 'pon0.4000（VLAN 4000，组播预留，已配置）' : '未配置（network 中无 pon0_4000 设备段）';
		};

		this.statusBox = E('div', { 'class': 'cbi-section' }, [E('h3', {}, '链路状态'), E('p', {}, '加载中…')]);

		return m.render().then(function(mapNode) {
			this.refreshStatus();
			return E('div', { 'class': 'cbi-map onu-scope' }, [
				mapNode,
				this.statusBox,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, '说明'),
					E('p', { 'class': 'cbi-section-descr' }, [
						'本页只管理数据链路。组播代理（omcproxy/igmpproxy）与组播转单播（udpxy 等）',
						'需要安装对应软件包，当前固件未预装。机顶盒接 LAN 口后如需 IGMP 代理再另行配置。'
					])
				])
			]);
		}.bind(this));
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
			dom.content(box, [E('h3', {}, '链路状态'), E('table', { 'class': 'table' }, rows)]);
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
