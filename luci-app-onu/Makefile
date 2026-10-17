# 增强版 PON 管理 LuCI 插件（上游 luci-app-pon 的 fork）
# 新增：光链路质量页（FEC 误码/光功率趋势）、事件日志页、补丁信息
# 新增：简体中文翻译（po/zh_Hans）
#
# 放进 OpenWrt/ImmortalWrt SDK 的 package/ 目录后直接 make menuconfig 选择
# 或放入源码树 feeds 后 ./scripts/feeds install luci-app-onu

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-onu
PKG_VERSION:=0.2.0
PKG_RELEASE:=1

LUCI_TITLE:=PON line management (enhanced, zh-CN)
LUCI_DEPENDS:=+luci-base +airoha-ponctl
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# define Package/luci-app-onu/postinst 如需可在此追加

# call BuildPackage - OpenWrt buildroot signature
