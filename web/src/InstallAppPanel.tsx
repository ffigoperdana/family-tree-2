import { Check, Download, MonitorDown, Share, Smartphone } from "lucide-react";

import type { Translator } from "./i18n";
import { detectInstallPlatform, useInstallApp } from "./installApp";
import { SidePanel } from "./ui";

export function InstallAppPanel({ onClose, t }: { onClose: () => void; t: Translator }) {
  const install = useInstallApp();
  const platform = install.platform;
  const ios = platform === "ios";
  const desktop = platform === "desktop";
  return (
    <SidePanel closeLabel={t("close")} onClose={onClose} title={t("installAppTitle")}>
      <div className="install-app-panel">
        <div className="install-app-hero">
          <img alt="" aria-hidden="true" className="brand-mark" height={192} src="/soenarto-tree-mark.svg" width={192} />
          <div><h3>{t("installAppTitle")}</h3><p>{t("installAppIntro")}</p></div>
        </div>
        {install.installed ? (
          <div className="install-status"><Check aria-hidden="true" size={19} /><span><strong>{t("installAppInstalled")}</strong><small>{t("installAppInstalledDetail")}</small></span></div>
        ) : install.canPrompt ? (
          <button className="button primary full" onClick={() => void install.install()} type="button"><Download aria-hidden="true" size={17} /> {t("installAppButton")}</button>
        ) : ios ? (
          <section className="install-instructions">
            <div className="install-instruction-icon"><Share aria-hidden="true" size={20} /></div>
            <div><strong>{t("installIosTitle")}</strong><p>{t("installIosDetail")}</p><ol><li>{t("installIosStepOne")}</li><li>{t("installIosStepTwo")}</li><li>{t("installIosStepThree")}</li></ol></div>
          </section>
        ) : (
          <section className="install-instructions">
            <div className="install-instruction-icon">{desktop ? <MonitorDown aria-hidden="true" size={20} /> : <Smartphone aria-hidden="true" size={20} />}</div>
            <div><strong>{t("installBrowserTitle")}</strong><p>{t("installBrowserDetail")}</p></div>
          </section>
        )}
        <p className="install-app-note">{t("installAppOfflineDetail")}</p>
      </div>
    </SidePanel>
  );
}

export { detectInstallPlatform };
