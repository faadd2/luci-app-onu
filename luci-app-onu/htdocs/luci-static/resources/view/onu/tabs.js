'use strict';
/*
 * ONU 连接管理页通用分页组件（对齐 Argon 主题 ul.cbi-tabmenu > li[.cbi-tab] > a 结构）
 * 用法：'require view.onu.tabs as tabs';
 *   return tabs.render([{name:'配置', content: nodeOrPromise}, ...]); // -> Promise<Element>
 * content 可为 DOM 节点或 Promise（render 后 resolve 成节点）
 * 注意：LuCI require 返回的是模块类的单例实例（luci.js classes[name]=instance），
 *       不能 new，故本组件为无状态设计，分页列表作为 render 参数传入。
 */
return L.Class.extend({
	render: function(tabList) {
		var root = E('div', {});
		var menu = E('ul', { 'class': 'cbi-tabmenu' });
		var panesWrap = E('div', {});
		var lis = [];
		var panes = [];
		var loaded = [];

		(tabList || []).forEach(function(t, i) {
			var a = E('a', {
				'href': '#',
				'click': function(ev) {
					ev.preventDefault();
					lis.forEach(function(el, j) {
						if (el)
							el.className = (j === i) ? 'cbi-tab' : '';
					});
					panes.forEach(function(el, j) {
						el.style.display = j === i ? '' : 'none';
					});
				}
			}, t.name);
			var li = E('li', { 'class': i === 0 ? 'cbi-tab' : '' }, a);
			lis.push(li);
			menu.appendChild(li);

			var pane = E('div', { 'style': i === 0 ? '' : 'display:none' });
			panes.push(pane);
			loaded.push(Promise.resolve(t.content).then(function(node) {
				if (node) pane.appendChild(node);
			}));
		});

		root.appendChild(menu);
		panes.forEach(function(p) { panesWrap.appendChild(p); });
		root.appendChild(panesWrap);
		return Promise.all(loaded).then(function() { return root; });
	}
});
