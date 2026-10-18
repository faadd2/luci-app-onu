'use strict';
'require dom';
'require form';
'require fs';
'require poll';
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
 * ACS 管理（TR-069/CWMP 远程管理）· 二期
 *  - 配置：easycwmp 参数（uci: easycwmp local/acs），保存后一键重启服务
 *  - 状态：easycwmpd 服务/客户端运行态 + 最近 inform 记录
 *  - 调试：TR-069 端口报文抓取（7547/9090，PCAP 下载）+ easycwmp 日志
 * 待办：下发包解析并自动应用联通下发配置
 */

var PCAP = '/tmp/acs-capture.pcap';
var CLOG = '/tmp/acs-capture.log';
var CPID = '/tmp/acs-capture.pid';

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c',
			'/etc/init.d/easycwmpd enabled && echo EN_ENABLED || echo EN_DISABLED; ' +
			'pidof easycwmpd easycwmp 2>/dev/null | tr "\\n" " "; echo; ' +
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED'
		]), '\n\nSTOPPED');
	},

	render: function(statusText) {
		var lines = String(statusText || '').split('\n');
		var self = this;

		var m = new form.Map('easycwmp', 'ACS 配置',
			'TR-069（CWMP）是运营商远程管理光猫的通道：光猫周期性向 ACS 上报，ACS 可反向下发或修改配置（北京联通的 PPPoE / IPTV / VoIP 业务参数均通过该通道下发）。客户端为 easycwmp。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.TypedSection, 'local', '本机监听（ConnectionRequest）',
			'ACS 反向主动连接光猫时使用的 HTTP 端口与认证');
		s.anonymous = true;
		s.addremove = false;

		var o = s.option(form.Flag, 'enable', '启用本机监听');
		o = s.option(form.Value, 'interface', '监听接口');
		o.placeholder = 'wan / voip / 留空全部';
		o.rmempty = true;
		o = s.option(form.Value, 'port', '监听端口');
		o.datatype = 'port';
		o.placeholder = '7547';

		var a = m.section(form.TypedSection, 'acs', 'ACS 服务器');
		a.anonymous = true;
		a.addremove = false;

		o = a.option(form.Value, 'url', 'ACS 地址');
		o.placeholder = 'http://acs.example.com:7547/';
		o.rmempty = true;

		o = a.option(form.Value, 'username', 'ACS 用户名');
		o.rmempty = true;

		o = a.option(form.Value, 'password', 'ACS 密码');
		o.password = true;
		o.rmempty = true;

		o = a.option(form.Flag, 'periodic_enable', '周期上报');

		o = a.option(form.Value, 'periodic_interval', '上报周期（秒）');
		o.datatype = 'uinteger';
		o.placeholder = '3600';
		o.depends('periodic_enable', '1');

		this.statusBox = E('div', { 'class': 'cbi-section' });
		this.renderStatus(lines[0] === 'EN_ENABLED', (lines[1] || '').trim(), lines[2] === 'RUNNING');
		poll.add(function() { return self.refreshStatus(); }, 5);

		this.debugLog = E('pre', {
			'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
				'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
		}, '点击「刷新日志」加载。');

		var cfgPane = m.render().then(function(mapNode) {
			return E('div', {}, [
				mapNode,
				self.statusBox,
				E('div', { 'class': 'cbi-page-actions' }, [
					E('button', {
						'class': 'cbi-button cbi-button-save',
						'click': ui.createHandlerFn(self, 'saveAndRestart')
					}, '保存并重启 ACS 客户端')
				])
			]);
		});

		return tabs.render([
			{ name: '配置', content: cfgPane },
			{
				name: '调试', content: E('div', {}, [
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, '报文抓取（TR-069 端口 7547/9090）'),
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button cbi-button-action',
								'click': ui.createHandlerFn(self, 'captureAction', 'start')
							}, '开始抓包'),
							E('button', {
								'class': 'cbi-button cbi-button-negative',
								'click': ui.createHandlerFn(self, 'captureAction', 'stop')
							}, '停止抓包'),
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'downloadPcap')
							}, '下载 PCAP')
						]),
						E('p', { 'class': 'cbi-section-descr' },
							'在 PON 口抓取 CWMP 会话报文。下发配置解析前的原始数据来源；EPON OAM/CTC 通道抓包见「光路诊断」页。')
					]),
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, 'easycwmp 日志'),
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button',
								'click': ui.createHandlerFn(self, 'refreshLog')
							}, '刷新日志')
						]),
						self.debugLog
					])
				])
			}
		]).then(function(node) {
			return E('div', { 'class': 'cbi-map onu-scope' }, node);
		});
	},

	renderStatus: function(enEnabled, pids, capturing) {
		var rows = [];
		function row(k, v) {
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
				E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v)
			]));
		}
		row('开机自启', enEnabled
			? E('span', { 'class': 'label label-success' }, '已启用')
			: E('span', { 'class': 'label label-warning' }, '未启用'));
		row('easycwmp 进程', pids
			? [E('span', { 'class': 'label label-success' }, '运行中'), ' (pid %s)'.format(pids)]
			: E('span', { 'class': 'label label-warning' }, '未运行'));
		row('报文抓取', capturing
			? E('span', { 'class': 'label label-success' }, '抓取中')
			: E('span', { 'class': 'label' }, '未启动'));
		dom.content(this.statusBox, [
			E('h3', {}, '运行状态'),
			E('table', { 'class': 'table' }, rows)
		]);
	},

	refreshStatus: function() {
		var self = this;
		return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c',
			'/etc/init.d/easycwmpd enabled && echo EN_ENABLED || echo EN_DISABLED; ' +
			'pidof easycwmpd easycwmp 2>/dev/null | tr "\\n" " "; echo; ' +
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED'
		]), '').then(function(text) {
			var lines = String(text || '').split('\n');
			self.renderStatus(lines[0] === 'EN_ENABLED', (lines[1] || '').trim(), lines[2] === 'RUNNING');
		});
	},

	saveAndRestart: function() {
		var map = document.querySelector('.cbi-map');
		return dom.callClassMethod(map, 'save')
			.then(function() {
				return fs.exec_direct('/etc/init.d/easycwmpd', ['restart']);
			})
			.then(function() {
				ui.addNotification(null, E('p', {}, '已保存并重启 easycwmpd。'), 'info');
			})
			.catch(function(err) {
				ui.addNotification(null, E('p', {}, '操作失败：%s'.format(err.message)), 'danger');
			});
	},

	refreshLog: function() {
		return fs.exec_direct('/sbin/logread', ['-e', 'easycwmp']).then(function(out) {
			var lines = (out || '').trim().split('\n').slice(-40);
			this.debugLog.textContent = lines.join('\n') || '（无 easycwmp 日志）';
		}.bind(this));
	},

	captureAction: function(action) {
		var cmd;
		if (action === 'start')
			cmd = 'rm -f ' + PCAP + ' ' + CLOG + '; /usr/bin/tcpdump -i pon0 -s 0 -nn -w ' + PCAP +
				' "port 7547 or port 9090" > ' + CLOG + ' 2>&1 & echo $! > ' + CPID;
		else
			cmd = 'kill "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null; rm -f ' + CPID;

		return fs.exec_direct('/bin/sh', ['-c', cmd]).then(function() {
			ui.addNotification(null, E('p', {},
				action === 'start' ? '抓包已启动，状态每 5 秒自动刷新。' : '抓包已停止。'), 'info');
		});
	},

	downloadPcap: function() {
		return L.resolveDefault(fs.read_direct(PCAP, 'blob'), null).then(function(blob) {
			if (!blob || !blob.size) {
				ui.addNotification(null, E('p', {}, 'PCAP 文件为空或不存在，请先抓包。'), 'warning');
				return;
			}
			var url = URL.createObjectURL(blob);
			var a = E('a', { 'href': url, 'download': 'acs-capture.pcap' });
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
