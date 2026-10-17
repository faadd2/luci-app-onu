'use strict';
'require dom';
'require fs';
'require poll';
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
 * PON 事件日志页（增强版新增）
 * 板块1：airoha-pond 守护进程事件（pondctl events，JSONL 流）
 * 板块2：内核日志中的 PON 相关条目（logread -e airoha，自动刷新）
 */

var MAX_EVENTS = 200;

var kernLogTimer = null;

function lineSections() {
	return uci.sections('pon', 'xpon');
}

function parseEventLines(text) {
	var events = [];
	String(text || '').split('\n').forEach(function(line) {
		line = line.trim();
		if (!line)
			return;
		try {
			var ev = JSON.parse(line);
			events.push(ev);
		} catch (e) {}
	});
	return events;
}

function formatTime(ts) {
	var d = new Date(Number(ts));
	return isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

var kindLabels = {
	'lifecycle':         { cls: 'label-info',    text: 'lifecycle' },
	'ieee-oam':          { cls: 'label-success', text: 'IEEE OAM' },
	'ctc':               { cls: 'label-primary', text: 'CTC OAM' },
	'oam':               { cls: 'label-primary', text: 'OAM' },
	'omci':              { cls: 'label-primary', text: 'OMCI' },
	'registration':      { cls: 'label-warning', text: 'registration' },
	'alarm':             { cls: 'label-danger',  text: 'alarm' },
	'error':             { cls: 'label-danger',  text: 'error' }
};

function kindBadge(kind) {
	var k = kindLabels[kind] || { cls: 'label-info', text: kind || 'event' };
	return E('span', { 'class': 'label %s'.format(k.cls), 'style': 'margin-right:6px' }, k.text);
}

function renderEvents(events, emptyText) {
	if (!events.length)
		return E('p', {}, emptyText);
	var list = E('div', { 'style': 'max-height:420px;overflow-y:auto;font-family:monospace;font-size:12px' });
	events.slice(-MAX_EVENTS).reverse().forEach(function(ev) {
		list.appendChild(E('div', { 'style': 'padding:2px 0;border-bottom:1px dashed #eee' }, [
			E('span', { 'style': 'color:#999;margin-right:8px' }, formatTime(ev.timestamp_ms)),
			kindBadge(ev.kind),
			E('span', {}, ev.message || '')
		]));
	});
	return list;
}

function renderKernLog(text, filter) {
	var lines = String(text || '').split('\n').filter(function(l) { return l.trim(); });
	if (filter)
		lines = lines.filter(function(l) { return l.indexOf(filter) >= 0; });
	if (!lines.length)
		return E('p', {}, '没有匹配的日志条目。');
	var list = E('div', { 'style': 'max-height:420px;overflow-y:auto;font-family:monospace;font-size:12px' });
	lines.slice(-MAX_EVENTS).reverse().forEach(function(l) {
		var warn = l.indexOf('warn') >= 0 || l.indexOf('err') >= 0;
		list.appendChild(E('div', {
			'style': 'padding:2px 0;border-bottom:1px dashed #eee;word-break:break-all;' +
				(warn ? 'color:#c00;' : '')
		}, l));
	});
	return list;
}

return view.extend({
	load: function() {
		return uci.load('pon');
	},

	render: function() {
		var self = this;
		var lines = lineSections();
		var lineName = (lines[0] && lines[0]['.name']) || 'line0';
		var lineSelect = E('select', { 'class': 'cbi-input-select' }, lines.map(function(s) {
			return E('option', {
				'value': s['.name'],
				'selected': s['.name'] === lineName ? '' : null
			}, '%s (%s)'.format(s['.name'], s.device || '-'));
		}));

		var eventsBox = E('div', { 'id': 'pon-events-list' }, E('p', {}, '点击"刷新"加载事件。'));
		var logFilter = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder': '筛选…',
			'style': 'width:200px',
			'input': function() { self.refreshKernLog(); }
		});
		var kernBox = E('div', { 'id': 'pon-kern-list' }, E('p', {}, '加载中…'));

		var autoRefresh = E('input', { 'type': 'checkbox', 'checked': 'checked' });
		autoRefresh.addEventListener('change', function() {
			if (autoRefresh.checked)
				self.startKernPolling(kernBox, logFilter);
			else
				self.stopKernPolling();
		});

		this.kernBox = kernBox;
		this.logFilter = logFilter;

		var root = E('div', { 'class': 'cbi-map onu-scope' }, [
			E('h2', {}, 'PON 事件日志'),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, 'PON 守护进程事件'),
				E('p', { 'class': 'cbi-value-description' },
					'airoha-pond 上报的事件：OAM 发现、CTC 交互、注册和告警。事件流读取 2 秒后自动停止。'),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, 'PON 线路'),
					E('div', { 'class': 'cbi-value-field' }, [
						lineSelect, ' ',
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, 'refreshEvents', lineSelect, eventsBox)
						}, '刷新')
					])
				]),
				eventsBox
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '内核日志（PON）'),
				E('p', { 'class': 'cbi-value-description' },
					'airoha-xpon 驱动的内核消息，包括 "EPON MAC error interrupt" 行。'),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, '筛选'),
					E('div', { 'class': 'cbi-value-field' }, [
						logFilter, ' ',
						E('label', { 'style': 'margin-left:12px' }, [
							autoRefresh, ' ', '自动刷新（5 秒）'
						])
					])
				]),
				kernBox
			])
		]);

		this.startKernPolling(kernBox, logFilter);

		return root;
	},

	refreshEvents: function(lineSelect, box) {
		box.innerHTML = '';
		box.appendChild(E('p', {}, '加载中…'));
		/* pondctl events 会持续跟随，用 timeout 掐头取缓冲 */
		return L.resolveDefault(fs.exec('/usr/bin/timeout', ['2', 'pondctl', 'events', '--line', lineSelect.value]), null)
			.then(function(result) {
				var events = parseEventLines(result ? result.stdout : '');
				dom.content(box, renderEvents(events, '守护进程还没有上报事件。'));
			});
	},

	refreshKernLog: function() {
		var box = this.kernBox, filter = this.logFilter;
		if (!box)
			return Promise.resolve();
		return L.resolveDefault(fs.exec_direct('/sbin/logread', ['-e', 'airoha']), '')
			.then(function(text) {
				dom.content(box, renderKernLog(text, filter.value.trim()));
			});
	},

	startKernPolling: function() {
		this.stopKernPolling();
		this.refreshKernLog();
		kernLogTimer = poll.add(L.bind(this.refreshKernLog, this), 5);
	},

	stopKernPolling: function() {
		if (kernLogTimer != null) {
			poll.remove(kernLogTimer);
			kernLogTimer = null;
		}
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
