# 504 语音链路的 ASoC 内核模块打包（B 侧 10-17 新增）
# 背景：SND 全家从 =y 改 =m（A 拍板，固件内 opkg 可装 baresip-mod-alsa 是硬需求），
# 但 OpenWrt 只为 sound.mk 里显式定义过的 Kconfig 符号出 kmod 包——
# CONFIG_SND_SOC_AN7581 / _LE9643 是 201-03 补丁新增的符号，无人认领 =m 模块会被
# 构建系统丢弃（unclaimed），所以在此补 KernelPackage 定义。
# 内核源码路径与目标名实证：201-03 补丁 sound/soc/mediatek/an7581/Makefile
#   obj-$(CONFIG_SND_SOC_AN7581)        += snd-soc-an7581-afe.o
#   obj-$(CONFIG_SND_SOC_AN7581_LE9643) += an7581-le9643.o

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

define KernelPackage/sound-soc-an7581
  SUBMENU:=Sound support
  TITLE:=Airoha AN7581 AFE audio frontend
  DEPENDS:=+kmod-sound-soc-core
  KCONFIG:=CONFIG_SND_SOC_AN7581
  FILES:=$(LINUX_DIR)/sound/soc/mediatek/an7581/snd-soc-an7581-afe.ko
  AUTOLOAD:=$(call AutoProbe,snd-soc-an7581-afe)
endef

define KernelPackage/sound-soc-an7581/description
  Airoha AN7581 Audio Front End (AFE) SoC audio driver,
  patched in by kernel-patches/201-03 (voice line).
endef

define KernelPackage/sound-soc-an7581-le9643
  SUBMENU:=Sound support
  TITLE:=Lantiq/Dialogic LE9643 SLIC machine driver (AN7581)
  DEPENDS:=+kmod-sound-soc-an7581
  KCONFIG:=CONFIG_SND_SOC_AN7581_LE9643
  FILES:=$(LINUX_DIR)/sound/soc/mediatek/an7581/an7581-le9643.ko
  AUTOLOAD:=$(call AutoProbe,an7581-le9643)
endef

define KernelPackage/sound-soc-an7581-le9643/description
  Machine driver binding the LE9643 SLIC codec to the AN7581 AFE
  PCM interfaces (playback/capture for the phone port).
endef

$(eval $(call KernelPackage,sound-soc-an7581))
$(eval $(call KernelPackage,sound-soc-an7581-le9643))
