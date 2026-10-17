'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require ui';
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
 * ACS 管理（TR-069/CWMP 远程管理）· 一期
 *  - 状态：cwmp 客户端探测 + 抓包进程状态
 *  - 配置：ACS 参数存档（uci: acs.settings），安装 cwmp 客户端后生效
 *  - 原始数据：tcpdump 抓取 TR-069 端口报文（7547/9090）+ 文本快照 + PCAP 下载
 * 二期（待下发包解包逻辑完成后）：自动应用联通下发配置
 */

var PCAP = '/tmp/acs-capture.pcap';
var CLOG = '/tmp/acs-capture.log';
var CPID = '/tmp/acs-capture.pid';

return view.extend({
	load: function() {
		return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c',
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED; ' +
			'pidof easycwmp cwmp cwmpClient tr069 2>/dev/null | tr "\\n" " " || true'
		]), 'STOPPED\n');
	},

	render: function(statusText) {
		var lines = String(statusText || '').split('\n');

		var m = new form.Map('acs', 'ACS 配置',
			'TR-069（CWMP）是运营商远程管理光猫的通道：光猫周期性向 ACS 上报，ACS 可反向下发或修改配置（北京联通的 PPPoE / IPTV / VoIP 业务参数均通过该通道下发）。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.NamedSection, 'settings', 'acs', 'ACS 参数');
		s.addremove = false;

		var o = s.option(form.Flag, 'enabled', '启用 TR-069');
		o.description = '当前固件未内置 cwmp 客户端，参数仅存档；安装 easyCwmp 等客户端后按此处配置生效';

		o = s.option(form.Value, 'acs_url', 'ACS 地址');
		o.placeholder = 'http://acs.example.com:7547/';
		o.rmempty = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'acs_username', 'ACS 用户名');
		o.rmempty = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'acs_password', 'ACS 密码');
		o.password = true;
		o.rmempty = true;
		o.depends('enabled', '1');

		o = s.option(form.Flag, 'periodic_inform', '周期上报');
		o.depends('enabled', '1');

		o = s.option(form.Value, 'inform_interval', '上报周期（秒）');
		o.datatype = 'uinteger';
		o.placeholder = '3600';
		o.depends('periodic_inform', '1');

		o = s.option(form.Value, 'connreq_username', 'ConnectionRequest 用户名');
		o.description = 'ACS 主动连接光猫（反向连接请求）时使用的 HTTP 认证';
		o.rmempty = true;
		o.depends('enabled', '1');

		o = s.option(form.Value, 'connreq_password', 'ConnectionRequest 密码');
		o.password = true;
		o.rmempty = true;
		o.depends('enabled', '1');

		var self = this;

		var statusBox = E('div', { 'class': 'cbi-section' });
		this.statusBox = statusBox;
		this.renderStatus(lines[0] === 'RUNNING', (lines[1] || '').trim());

		var rawBox = E('pre', {
			'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
				'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
		}, '尚无抓取数据。');

		return m.render().then(function(mapNode) {
			poll.add(function() { return self.refreshAll(); }, 3);

			return E('div', { 'class': 'cbi-map onu-scope' }, [
				mapNode,
				statusBox,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, '原始数据抓取'),
					E('p', { 'class': 'cbi-section-descr' },
						'在 PON 口抓取 TR-069 报文（TCP 端口 7547 / 9090）。当前固件无 cwmp 客户端，这里主要能观察到：' +
						'① 联通 ACS 的主动连接请求（入站 7547）；② 后续安装客户端后的完整 CWMP 会话。' +
						'EPON OAM/CTC 通道的下发数据抓包见「光路诊断」页。'),
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
					E('h3', {}, '抓取原始记录'),
					rawBox
				])
			]);
		});
	},

	renderStatus: function(running, clientPids) {
		var rows = [];
		function row(k, v) {
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
				E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v)
			]));
		}
		row('TR-069 客户端', clientPids
			? [E('span', { 'class': 'label label-success' }, '运行中'), ' (pid %s)'.format(clientPids)]
			: E('span', { 'class': 'label label-warning' }, '未安装'));
		row('抓包进程', running
			? E('span', { 'class': 'label label-success' }, '抓取中')
			: E('span', { 'class': 'label' }, '未启动'));
		dom.content(this.statusBox, [
			E('h3', {}, '运行状态'),
			E('table', { 'class': 'table' }, rows)
		]);
	},

	refreshAll: function() {
		var self = this;
		return L.resolveDefault(fs.exec_direct('/bin/sh', ['-c',
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED; ' +
			'pidof easycwmp cwmp cwmpClient tr069 2>/dev/null | tr "\\n" " "; echo; ' +
			'[ -f ' + CLOG + ' ] && tail -n 3 ' + CLOG + '; ' +
			'echo ===PACKETS===; ' +
			'[ -f ' + PCAP + ' ] && tcpdump -r ' + PCAP + ' -nn -tttt 2>/dev/null | tail -n 30'
		]), '').then(function(text) {
			var lines = String(text || '').split('\n');
			self.renderStatus(lines[0] === 'RUNNING', (lines[1] || '').trim());

			var idx = lines.indexOf('===PACKETS===');
			var logLines = lines.slice(2, idx > 2 ? idx : lines.length);
			var pktLines = idx >= 0 ? lines.slice(idx + 1) : [];

			var out = '';
			if (logLines.length && logLines.join('').trim())
				out += '— tcpdump 输出 —\n' + logLines.join('\n') + '\n\n';
			if (pktLines.length && pktLines.join('').trim())
				out += '— 已抓报文（最近 30 条）—\n' + pktLines.join('\n');
			if (!out)
				out = '尚无抓取数据。';

			var map = document.querySelector('.cbi-map');
			var pre = map ? map.querySelector('pre') : null;
			if (pre)
				pre.textContent = out;
		});
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
				action === 'start' ? '抓包已启动，状态每 3 秒自动刷新。' : '抓包已停止。'), 'info');
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
