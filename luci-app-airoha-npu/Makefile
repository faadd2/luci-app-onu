include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-airoha-npu
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

# Chinese-improved fork of luanmuc/luci-app-airoha-npu (luci-app-onu style).
# Ships patched zh-cn lmo (LuCI 25/26 unified translation endpoint).
LUCI_TITLE:=Airoha NPU status panel (zh-cn)
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
