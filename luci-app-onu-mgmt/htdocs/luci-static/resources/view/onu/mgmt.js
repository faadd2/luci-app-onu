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
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED; ' +
			'command -v easycwmpd >/dev/null 2>&1 && echo CWMP_INSTALLED || echo CWMP_MISSING; ' +
			'[ "$(uci -q get easycwmp.@local[0].enable_acs)" = "0" ] && echo ACS_OFF || echo ACS_ON'
		]), '\n\nSTOPPED\nCWMP_MISSING\nACS_ON');
	},

	render: function(statusText) {
		var lines = String(statusText || '').split('\n');
		var self = this;

		var m = new form.Map('easycwmp', 'ACS 配置',
			'TR-069（CWMP）是运营商远程管理光猫的通道：光猫周期性向 ACS 上报，ACS 可反向下发或修改配置（北京联通的 PPPoE / IPTV / VoIP 业务参数均通过该通道下发）。');
		m.readonly = !L.hasViewPermission();

		var s = m.section(form.TypedSection, 'local', '本机监听（ConnectionRequest）',
			'「监听接口 / 监听端口」决定 ACS 主动连接光猫时连到哪个地址；「ConnectionRequest 用户名 / 密码」是连接到达后光猫要求 ACS 出示的认证口令（认证方向：ACS → 光猫）。' +
			'对照上方「ACS 服务器」里的 ACS 用户名 / 密码：那是光猫周期性向 ACS 上报时光猫自己出示的凭据（方向：光猫 → ACS）。两组凭据方向相反，用途不同，请勿填混。');
		s.anonymous = true;
		s.addremove = false;

		var o = s.option(form.Flag, 'enable_acs', '启用 ACS 客户端',
			'总开关：关闭后 easycwmpd 服务停用、全部参数隐藏');
		o.default = '1';

		o = s.option(form.Flag, 'enable', '启用本机监听',
			'开启后光猫在本机监听端口上等待 ACS 的反向连接请求（ConnectionRequest）');
		o.depends('enable_acs', '1');

		o = s.option(form.Value, 'interface', '监听接口',
			'CWMP 监听绑定的接口（留空 = 全部接口）。ACS 主动连接时连到该接口的 IP 上');
		o.placeholder = 'wan / voip / 留空全部';
		o.rmempty = true;
		o.depends('enable', '1');
		o.depends('enable_acs', '1');
		o = s.option(form.Value, 'port', '监听端口',
			'ACS 反向连接的 HTTP 端口，缺省 7547；运营商用 9090 时填 9090');
		o.datatype = 'port';
		o.placeholder = '7547';
		o.depends('enable', '1');
		o.depends('enable_acs', '1');

		o = s.option(form.Value, 'username', 'ConnectionRequest 用户名',
			'ACS 主动连接光猫时，光猫要求其通过的 HTTP 认证用户名（ACS → 光猫 方向）');
		o.rmempty = true;
		o.depends('enable_acs', '1');

		o = s.option(form.Value, 'password', 'ConnectionRequest 密码',
			'与用户名配套的认证密码；与「ACS 服务器」段的 ACS 密码方向相反、互不相同');
		o.password = true;
		o.rmempty = true;
		o.depends('enable_acs', '1');

		var a = m.section(form.TypedSection, 'acs', 'ACS 服务器');
		a.anonymous = true;
		a.addremove = false;

		o = a.option(form.Value, 'url', 'ACS 地址');
		o.placeholder = 'http://acs.example.com:7547/';
		o.rmempty = true;

		o = a.option(form.Value, 'username', 'ACS 用户名',
			'光猫向 ACS 上报时出示的认证用户名（方向：光猫 → ACS）');
		o.rmempty = true;

		o = a.option(form.Value, 'password', 'ACS 密码',
			'与 ACS 用户名配套；不是下方 ConnectionRequest 的那组，两者方向相反');
		o.password = true;
		o.rmempty = true;

		o = a.option(form.Flag, 'periodic_enable', '周期上报');

		o = a.option(form.Value, 'periodic_interval', '上报周期（秒）');
		o.datatype = 'uinteger';
		o.placeholder = '3600';
		o.depends('periodic_enable', '1');

		this.statusBox = E('div', { 'class': 'cbi-section' });
		this.renderStatus(lines[0] === 'EN_ENABLED', (lines[1] || '').trim(), lines[2] === 'RUNNING', lines[3] === 'CWMP_INSTALLED', lines[4] !== 'ACS_OFF');
		poll.add(function() { return self.refreshStatus(); }, 5);

		/* ---- 推荐客户端卡片 ---- */
		this.clientBadge = E('span', { 'class': 'label' }, '检测中…');
		this.clientCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, 'ACS 客户端'),
			E('p', { 'class': 'cbi-section-descr' },
				'推荐使用 easycwmp：轻量开源 CWMP 客户端，支持 TR-069 周期上报与 ACS 反向连接。安装/重装入口在「调试」页。'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'width: 30%' }, E('var', {}, 'easycwmp')),
					E('td', { 'class': 'td left' }, this.clientBadge)
				])
			])
		]);

		this.debugLog = E('pre', {
			'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
				'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
		}, '点击「刷新日志」加载。');

		this.captureLog = E('pre', {
			'style': 'max-height: 18em; overflow: auto; margin: 0.5rem 1rem 1rem; padding: 0.5em; ' +
				'background: rgba(127,127,127,0.08); font-size: 0.8125rem; white-space: pre-wrap;'
		}, '尚未开始抓包。');

		var cfgPane = m.render().then(function(mapNode) {
			/* 总开关折叠：enable_acs 在 local 段，acs 段的选项 depends 无法跨段引用，手动隐藏 */
			var enInput = mapNode.querySelector('[data-field$=".enable_acs"] input[type="checkbox"]');
			var urlBox = mapNode.querySelector('[data-field$=".url"]');
			var acsWrap = urlBox ? urlBox.closest('.cbi-section') : null;
			var applyAcsVis = function() {
				if (enInput && acsWrap)
					acsWrap.style.display = enInput.checked ? '' : 'none';
			};
			if (enInput) enInput.addEventListener('change', applyAcsVis);
			applyAcsVis();
			return E('div', {}, [
				mapNode,
				self.clientCard,
				E('div', { 'class': 'cbi-page-actions' }, [
					E('button', {
						'class': 'cbi-button cbi-button-save',
						'click': ui.createHandlerFn(self, 'saveAndRestart')
					}, '保存并应用（按总开关启停客户端）')
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
						E('h3', {}, '抓取原始记录'),
						E('p', { 'class': 'cbi-section-descr' },
							'tcpdump 实时输出与抓包统计（每 5 秒自动刷新；停止抓包后此处显示包数摘要）。'),
						self.captureLog
					]),
					E('div', { 'class': 'cbi-section' }, [
						E('h3', {}, 'ACS 客户端安装'),
						E('div', { 'class': 'cbi-page-actions' }, [
							E('button', {
								'class': 'cbi-button cbi-button-action',
								'click': ui.createHandlerFn(self, 'installClient')
							}, '安装 / 重装 easycwmp 客户端')
						]),
						E('p', { 'class': 'cbi-section-descr' },
							'优先从 /root/apks/ 下的离线安装包安装（刷机后需重新放入 easycwmp 与 libmicroxml1 的 apk），否则尝试在线源。')
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
			return E('div', { 'class': 'cbi-map onu-scope' }, [self.statusBox, node]);
		});
	},

	renderStatus: function(enEnabled, pids, capturing, installed, acsOn) {
		var rows = [];
		function row(k, v) {
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 30%' }, k),
				E('td', { 'class': 'td left' }, v == null || v === '' ? '-' : v)
			]));
		}
		row('ACS 客户端启用', acsOn != null
			? (acsOn
				? E('span', { 'class': 'label label-success' }, '已启用')
				: E('span', { 'class': 'label label-warning' }, '已停用'))
			: E('span', { 'class': 'label' }, '未配置'));
		row('开机自启', enEnabled
			? E('span', { 'class': 'label label-success' }, '已启用')
			: E('span', { 'class': 'label label-warning' }, '未启用'));
		row('easycwmp 进程', pids
			? [E('span', { 'class': 'label label-success' }, '运行中'), ' (pid %s)'.format(pids)]
			: E('span', { 'class': 'label label-warning' }, '未运行'));
		row('报文抓取', capturing
			? E('span', { 'class': 'label label-success' }, '抓取中')
			: E('span', { 'class': 'label' }, '未启动'));
		row('ACS 客户端', installed
			? E('span', { 'class': 'label label-success' }, '已安装')
			: E('span', { 'class': 'label label-warning' }, '未安装（推荐安装 easycwmp）'));
		if (this.clientBadge) {
			this.clientBadge.className = installed ? 'label label-success' : 'label label-warning';
			this.clientBadge.textContent = installed ? '已安装（推荐）' : '未安装（推荐安装）';
		}
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
			'kill -0 "$(cat ' + CPID + ' 2>/dev/null)" 2>/dev/null && echo RUNNING || echo STOPPED; ' +
			'command -v easycwmpd >/dev/null 2>&1 && echo CWMP_INSTALLED || echo CWMP_MISSING; ' +
			'[ "$(uci -q get easycwmp.@local[0].enable_acs)" = "0" ] && echo ACS_OFF || echo ACS_ON'
		]), '').then(function(text) {
			var lines = String(text || '').split('\n');
			self.renderStatus(lines[0] === 'EN_ENABLED', (lines[1] || '').trim(), lines[2] === 'RUNNING', lines[3] === 'CWMP_INSTALLED', lines[4] !== 'ACS_OFF');
		}).then(function() {
			if (!self.captureLog || !self.captureLog.isConnected)
				return;
			return fs.exec_direct('/bin/sh', ['-c',
				'echo "— tcpdump 输出 —"; tail -n 8 ' + CLOG + ' 2>/dev/null; ' +
				'[ -f ' + PCAP + ' ] && echo "— 已抓取 $(wc -c < ' + PCAP + ') 字节（PCAP）—" || echo "— 尚无 PCAP 文件 —"'
			]).then(function(out) {
				self.captureLog.textContent = (out || '').trim() || '尚未开始抓包。';
			});
		});
	},

	installClient: function() {
		return fs.exec_direct('/usr/libexec/onu-acs-install', []).then(function(out) {
			ui.addNotification(null, E('p', {}, (out || '').trim().split('\n').pop() || '执行完成'), 'info');
			return this.refreshStatus();
		}.bind(this));
	},

	saveAndRestart: function() {
		var map = document.querySelector('.cbi-map');
		return dom.callClassMethod(map, 'save')
			.then(function() {
				return fs.exec_direct('/bin/sh', ['-c',
					'if [ "$(uci -q get easycwmp.@local[0].enable_acs)" = "0" ]; then ' +
					'/etc/init.d/easycwmpd disable; /etc/init.d/easycwmpd stop; echo RESULT_DISABLED; ' +
					'else /etc/init.d/easycwmpd enable; /etc/init.d/easycwmpd restart; echo RESULT_ENABLED; fi']);
			})
			.then(function(out) {
				ui.addNotification(null, E('p', {},
					/RESULT_ENABLED/.test(out || '') ? '已保存并重启 easycwmpd。' : '已保存，ACS 客户端已停用并取消自启。'), 'info');
				return this.refreshStatus();
			}.bind(this))
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
