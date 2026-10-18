'use strict';
/*
 * ONU 连接管理页通用分页组件（仿 LuCI 系统/状态页 tabs）
 * 用法：'require view.onu.tabs as tabs';
 *   return tabs.render([{name:'配置', content: nodeOrPromise}, ...]); // -> Promise<Element>
 * content 可为 DOM 节点或 Promise（render 后 resolve 成节点）
 * 注意：LuCI require 返回的是模块类的单例实例（luci.js classes[name]=instance），
 *       不能 new，故本组件为无状态设计，分页列表作为 render 参数传入。
 */
return L.Class.extend({
	render: function(tabList) {
		var root = E('div', { 'class': 'cbi-tabs' });
		var menu = E('div', { 'class': 'cbi-tabs-menu' });
		var panes = [];
		var loaded = [];

		(tabList || []).forEach(function(t, i) {
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
