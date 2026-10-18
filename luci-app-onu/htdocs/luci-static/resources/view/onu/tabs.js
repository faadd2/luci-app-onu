'use strict';
/*
 * ONU 连接管理页通用分页组件（仿 LuCI 系统/状态页 tabs）
 * 用法：require view.onu.tabs
 *   var t = new tabs([{name:'配置', content: nodeOrPromise}, ...]);
 *   return t.render(); // -> Element
 * content 可为 DOM 节点或 Promise（render 后 resolve 成节点）
 */
return L.Class.extend({
	__init__: function(tabs) {
		this.tabs = tabs || [];
	},

	render: function() {
		var root = E('div', { 'class': 'cbi-tabs' });
		var menu = E('div', { 'class': 'cbi-tabs-menu' });
		var panes = [];
		var loaded = [];

		this.tabs.forEach(function(t, i) {
			menu.appendChild(E('a', {
				'href': '#',
				'class': 'cbi-tab' + (i === 0 ? ' active' : ''),
				'click': function(ev) {
					ev.preventDefault();
					menu.querySelectorAll('.cbi-tab').forEach(function(el, j) {
						el.classList.toggle('active', j === i);
					});
					panes.forEach(function(el, j) {
						el.style.display = j === i ? '' : 'none';
					});
				}
			}, t.name));

			var pane = E('div', { 'class': 'cbi-tab-pane', 'style': i === 0 ? '' : 'display:none' });
			panes.push(pane);
			loaded.push(Promise.resolve(t.content).then(function(node) {
				if (node) pane.appendChild(node);
			}));
		});

		root.appendChild(menu);
		panes.forEach(function(p) { root.appendChild(p); });
		return Promise.all(loaded).then(function() { return root; });
	}
});
