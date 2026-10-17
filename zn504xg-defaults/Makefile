include $(TOPDIR)/rules.mk

PKG_NAME:=zn504xg-defaults
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=ZN504XG-D voice porting project
PKG_LICENSE:=GPL-2.0

include $(INCLUDE_DIR)/package.mk

define Package/zn504xg-defaults
  SECTION:=base
  CATEGORY:=Base system
  TITLE:=ZN504XG-D first-boot defaults (flow offloading, distfeeds fix)
  PKGARCH:=all
endef

define Package/zn504xg-defaults/description
  First-boot uci-defaults for ZN504XG-D:
    - firewall software+hardware flow offloading enabled
    - dead apk distfeeds (pon_drivers/pon_userspace/video) removed
    - /usr/bin/speedtest symlink to ookla-speedtest
endef

define Build/Compile
endef

define Package/zn504xg-defaults/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/99-zn504xg-defaults $(1)/etc/uci-defaults/
endef

$(eval $(call BuildPackage,zn504xg-defaults))
