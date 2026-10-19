// SPDX-License-Identifier: Apache-2.0
// 配置迁移向导：上传旧光猫备份 → 解析预览 → 勾选应用到本机 UCI
// 视图放 onu 组（admin/onu/migrate）。解析在本机浏览器完成，密码只在应用时写入 UCI。
'use strict';
'require view';
'require ui';
'require uci';
'require dom';
'require onu-migrate/parser as parser';

/* 共享主题样式 onu.css（暗色主题 label 徽标/表格标题行修复）；id 防重复 */
if (!document.getElementById('onu-shared-css')) {
	var _onuCss = document.createElement('link');
	_onuCss.id = 'onu-shared-css';
	_onuCss.rel = 'stylesheet';
	_onuCss.href = L.resource('view/onu/onu.css') + '?v=3';
	document.head.appendChild(_onuCss);
}

var SERVICE_LABEL = {
	internet: '上网',
	management: '管理通道',
	iptv: 'IPTV',
	voip: '语音'
};

var MODE_LABEL = { pppoe: 'PPPoE', dhcp: 'DHCP', bridge: '桥接' };

// 业务 → 本机目标 interface 段名；management 不迁移（运营商通道）
var TARGET = { internet: 'wan', iptv: 'iptv', voip: 'voip' };

return view.extend({
	model: null,
	parsed: null,

	load: function () {
		return L.uci.load('network');
	},

	findDeviceSection: function (ifname) {
		var devs = L.uci.sections('network', 'device');
		for (var i = 0; i < devs.length; i++)
			if (devs[i].name === ifname)
				return devs[i]['.name'];
		return null;
	},

	findInterfaceByDevice: function (ifname) {
		var ifs = L.uci.sections('network', 'interface');
		for (var i = 0; i < ifs.length; i++)
			if (ifs[i].device === ifname)
				return ifs[i]['.name'];
		return null;
	},

	handleFile: function (ev) {
		var file = ev.target.files[0];
		var view = this;
		if (!file)
			return;
		var reader = new FileReader();
		reader.onload = function () {
			view.parsed = parser.parseConfigImport(String(reader.result));
			if (view.parsed.error) {
				view.showError('无法识别的文件格式：' + view.parsed.error);
				return;
			}
			view.renderPreview();
		};
		reader.readAsText(file);
	},

	showError: function (msg) {
		var box = document.getElementById('migrate-status');
		if (box)
			box.innerHTML = '';
		ui.addNotification(null, E('p', msg), 'error');
	},

	// 业务归属提示（随下拉框选择动态更新）
	noteFor: function (w, svc) {
		var target = TARGET[svc];
		if (!target)
			return '不迁移（运营商管理/未知通道）';
		var existing = this.findInterfaceByDevice('pon0.' + w.vlan);
		if (existing === 'wan')
			return '将更新现有上网拨号的参数';
		if (existing)
			return '本机接口 ' + existing + ' 已使用该 VLAN，跳过';
		return target === 'wan' ? '迁移上网到此 VLAN（覆盖现有拨号）' : '创建接口 ' + target;
	},

	// 预览表：每行一个 WAN 条目；业务归属可改（解析结果仅为建议）
	renderPreview: function () {
		var view = this;
		var box = document.getElementById('migrate-preview');
		if (!box)
			return;
		var rows = (this.parsed.wan || []).map(function (w) {
			var svcSelect = E('select', {
				'class': 'cbi-input-select migrate-svc',
				'data-index': w.index,
				change: function () {
					var idx = this.getAttribute('data-index');
					var cell = document.querySelector('.migrate-note[data-index="' + idx + '"]');
					if (cell)
						dom.content(cell, view.noteFor(view.parsed.wan[idx], this.value));
				}
			}, Object.keys(SERVICE_LABEL).map(function (svc) {
				return E('option', { value: svc, selected: (svc === w.service) ? 'selected' : null },
					SERVICE_LABEL[svc]);
			}));
			return E('tr', {}, [
				E('td', {}, E('input', {
					type: 'checkbox',
					'class': 'migrate-pick',
					'data-index': w.index,
					checked: (TARGET[w.service] && !view.findInterfaceByDevice('pon0.' + w.vlan)) ? 'checked' : null
				})),
				E('td', {}, svcSelect),
				E('td', {}, MODE_LABEL[w.mode] || w.mode),
				E('td', {}, w.vlan || '无'),
				E('td', {}, w.prio),
				E('td', {}, w.mtu),
				E('td', {}, w.igmp ? '是' : '否'),
				E('td', {}, w.username ? (w.username.slice(0, 3) + '***') : '—'),
				E('td', { 'class': 'migrate-note', 'data-index': w.index }, view.noteFor(w, w.service))
			]);
		});
		box.innerHTML = '';
		dom.append(box, E('div', { 'class': 'cbi-map onu-scope' }, [
			E('h3', {}, '解析结果（' + (this.parsed.wan || []).length + ' 条连接）'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles', 'style': 'text-align:left' }, [
					E('th'), E('th', {}, '业务'), E('th', {}, '模式'),
					E('th', {}, 'VLAN'), E('th', {}, '优先级'), E('th', {}, 'MTU'),
					E('th', {}, 'IGMP'), E('th', {}, '账号'), E('th', {}, '应用方式')
				])
			].concat(rows)),
			E('div', { style: 'margin-top:1em' }, [
				E('button', {
					'class': 'cbi-button cbi-button-apply',
					click: ui.createHandlerFn(view, 'handleApply')
				}, '应用到本机'),
				' ',
				E('span', { 'class': 'migrate-result', style: 'margin-left:1em' })
			])
		]));
	},

	// 应用勾选项 → UCI（业务归属以用户下拉框选择为准）
	handleApply: function () {
		var view = this;
		var picks = document.querySelectorAll('.migrate-pick:checked');
		if (!picks.length) {
			this.showError('未勾选任何条目');
			return;
		}
		var model = this.parsed;
		var applied = [], skipped = [];

		Array.prototype.forEach.call(picks, function (cb) {
			var idx = cb.getAttribute('data-index');
			var w = model.wan[parseInt(idx, 10)];
			var sel = document.querySelector('.migrate-svc[data-index="' + idx + '"]');
			var svc = sel ? sel.value : w.service;
			var target = TARGET[svc];
			if (!target) {
				skipped.push('VLAN ' + w.vlan + '（未选业务）');
				return;
			}
			var ifname = 'pon0.' + w.vlan;
			var existing = view.findInterfaceByDevice(ifname);

			// 已有接口占用该 VLAN
			if (existing) {
				if (existing === 'wan' && svc === 'internet') {
					if (w.username) L.uci.set('network', 'wan', 'username', w.username);
					if (w.password) L.uci.set('network', 'wan', 'password', w.password);
					L.uci.set('network', 'wan', 'mtu', String(w.mtu || 1492));
					applied.push('上网拨号参数已更新（VLAN ' + w.vlan + '）');
				} else {
					skipped.push(SERVICE_LABEL[svc] + '（VLAN ' + w.vlan + ' 已被 ' + existing + ' 占用）');
				}
				return;
			}

			// 1) VLAN device 段
			if (!view.findDeviceSection(ifname)) {
				var s = L.uci.add('network', 'device', 'pon0_' + w.vlan);
				L.uci.set('network', s, 'type', '8021q');
				L.uci.set('network', s, 'name', ifname);
				L.uci.set('network', s, 'ifname', 'pon0');
				L.uci.set('network', s, 'vid', String(w.vlan));
			}
			// 2) interface 段
			if (target === 'wan') {
				var wan = L.uci.get('network', 'wan') ? 'wan' : L.uci.add('network', 'interface', 'wan');
				L.uci.set('network', wan, 'device', ifname);
				L.uci.set('network', wan, 'proto', 'pppoe');
				if (w.username) L.uci.set('network', wan, 'username', w.username);
				if (w.password) L.uci.set('network', wan, 'password', w.password);
				L.uci.set('network', wan, 'mtu', String(w.mtu || 1492));
				L.uci.set('network', wan, 'norelease', '1');
			} else {
				var name = L.uci.get('network', target) ? target :
					L.uci.add('network', 'interface', target);
				L.uci.set('network', name, 'device', ifname);
				L.uci.set('network', name, 'proto', 'dhcp');
				if (target === 'voip')
					L.uci.set('network', name, 'defaultroute', '0');
			}
			applied.push(SERVICE_LABEL[svc] + ' → ' + target + ' (pon0.' + w.vlan + ')');
		});

		if (!applied.length) {
			this.showError('没有可应用的条目（' + (skipped.join('、') || '无变化') + '）');
			return;
		}

		return L.uci.save().then(function () {
			return L.uci.apply();
		}).then(function () {
			var msg = '已应用：' + applied.join('；') +
				(skipped.length ? '。跳过：' + skipped.join('、') : '') +
				'。上网拨号若未自动重连，请到「上网」页重新连接。';
			ui.addNotification(null, E('p', msg), 'info');
			var box = document.querySelector('.migrate-result');
			if (box)
				dom.content(box, msg);
		}).catch(function (e) {
			view.showError('应用失败：' + (e.message || e));
		});
	},

	render: function () {
		var view = this;
		return E('div', { 'class': 'cbi-map onu-scope' }, [
			E('h2', {}, '配置迁移'),
			E('p', {}, '从旧光猫备份文件解析业务配置（上网 / IPTV / 语音），迁移到本机。' +
				'支持友华/Realtek 格式备份（config_xml）与 CWMP/TR-069 报文；' +
				'文件在本机浏览器内解析，账号密码只在确认应用时写入配置。' +
				'解析出的业务归属仅为建议，请逐条核对后再应用。'),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, '备份文件'),
					E('div', { 'class': 'cbi-value-field' }, [
						E('input', {
							type: 'file',
							accept: '.xml,.bak,.txt,.soap,.log',
							change: ui.createHandlerFn(view, 'handleFile')
						})
					])
				])
			]),
			E('div', { id: 'migrate-preview' }),
			E('div', { id: 'migrate-status' })
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
