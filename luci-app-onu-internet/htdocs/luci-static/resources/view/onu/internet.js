'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';
'require view';
'require view.onu.tabs as tabs';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css');
	document.head.appendChild(_onuCss);
}

/*
 * 上网业务模块（北京联通 10G-EPON）
 * 数据源：UCI network.wan（pppoe/dhcp over pon0.<vlan>）
 */

function parseVid(device) {
	var m = /^(pon0)\.(\d{1,4})$/.exec(device || '');
	return m ? m[2] : '';
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

		var o = s.option(form.ListValue, 'proto', '上网方式');
		o.value('pppoe', 'PPPoE 拨号');
		o.value('dhcp', 'DHCP 客户端');
		o.value('none', '停用');

		o = s.option(form.Value, '_vlan', '上网 VLAN ID');
		o.placeholder = '3961';
		o.datatype = 'range(1,4094)';
		o.cfgvalue = function() { return parseVid(uci.get('network', 'wan', 'device')); };
		o.write = function(sectionId, value) {
			uci.set('network', 'wan', 'device', 'pon0.' + value);
		};
		o.remove = function() {};
		o.depends('proto', 'pppoe');
		o.depends('proto', 'dhcp');

		o = s.option(form.Value, 'username', 'PPPoE 账号');
		o.depends('proto', 'pppoe');

		o = s.option(form.Value, 'password', 'PPPoE 密码');
		o.password = true;
		o.depends('proto', 'pppoe');

		o = s.option(form.Value, 'mtu', 'MTU');
		o.datatype = 'range(576,1500)';
		o.placeholder = '1492';
		o.depends('proto', 'pppoe');

		o = s.option(form.Flag, 'norelease', '断开时不发送 PADT');
		o.description = '保持会话，缩短掉线后重连时间（建议开启）';
		o.depends('proto', 'pppoe');

		o = s.option(form.Flag, 'defaultroute', '设为默认网关');
		o.default = o.enabled;

		var self = this;
		var statusBox = E('div', { 'class': 'cbi-section' }, [E('h3', {}, '连接状态'), E('p', {}, '加载中…')]);

		this.statusBox = statusBox;

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
								E('button', {
									'class': 'cbi-button cbi-button-action',
									'click': ui.createHandlerFn(self, 'reconnect')
								}, '保存并重新拨号'),
								E('button', {
									'class': 'cbi-button',
									'click': ui.createHandlerFn(self, 'reloadOnly')
								}, '仅重载网络配置')
							]),
							E('p', { 'class': 'cbi-section-descr' }, '「保存并重新拨号」会先提交上方表单，再重启 wan 接口。')
						])
					])
				},
				{ name: '状态', content: self.statusBox },
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
				return E('div', { 'class': 'cbi-map onu-scope' }, node);
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

	reconnect: function() {
		var map = document.querySelector('.cbi-map');
		var self = this;
		return dom.callClassMethod(map, 'save')
			.then(function() {
				return L.resolveDefault(fs.exec_direct('/sbin/ifdown', ['wan']), '');
			})
			.then(function() {
				return L.resolveDefault(fs.exec_direct('/sbin/ifup', ['wan']), '');
			})
			.then(function() {
				ui.addNotification(null, E('p', {}, '已保存并触发重新拨号，约 10 秒后刷新状态。'), 'info');
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
