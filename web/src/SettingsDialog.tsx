import { Globe2, Languages, Moon, ShieldCheck, Sun } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { AppVersion } from "./AppVersion";
import type { MessageKey, Translator } from "./i18n";
import { relationshipLanguageForData } from "./kinship";
import { passwordRequirements } from "./passwordPolicy";
import type { AppActions } from "./store";
import type { AppData, RelationshipLanguage } from "./types";
import { ButtonLoader, SidePanel } from "./ui";
import { setUiTheme, useUiTheme } from "./uiTheme";

interface SettingsDialogProps {
  data: AppData;
  actions: AppActions;
  t: Translator;
  onClose: () => void;
}

const relationshipLanguageOptions: ReadonlyArray<readonly [RelationshipLanguage, MessageKey]> = [
  ["en", "english"],
  ["id", "indonesianRelationships"],
  ["jv-yogyakarta", "javaneseYogyakarta"],
  ["jv-east-java", "javaneseEastJava"],
  ["jv-cirebon", "cirebonRelationships"],
  ["su-priangan", "sundaneseRelationships"],
  ["bbc-toba", "tobaRelationships"],
  ["btx-karo", "karoRelationships"],
  ["btm-mandailing", "mandailingRelationships"],
  ["akb-angkola", "angkolaRelationships"],
  ["bts-simalungun", "simalungunRelationships"],
  ["btd-pakpak", "pakpakRelationships"]
];

export const archivePasswordRequirements = (password: string) => passwordRequirements(password);

export const archivePasswordMeetsRequirements = (password: string) =>
  password.length === 0 || Object.values(archivePasswordRequirements(password)).every(Boolean);

export const archivePasswordIsReady = (password: string, confirmation: string) =>
  password === confirmation && archivePasswordMeetsRequirements(password);

export function SettingsDialog({
  data,
  actions,
  t,
  onClose
}: SettingsDialogProps) {
  const [pendingLanguage, setPendingLanguage] = useState<AppData["language"]>();
  const [isPending, startTransition] = useTransition();
  const changingLanguage = useRef(false);
  const relationshipLanguage = relationshipLanguageForData(data);
  const theme = useUiTheme();

  useEffect(() => {
    if (!isPending) changingLanguage.current = false;
  }, [isPending]);

  const changeLanguage = (language: AppData["language"]) => {
    if (language === data.language || changingLanguage.current) return;
    changingLanguage.current = true;
    setPendingLanguage(language);
    startTransition(() => actions.setLanguage(language));
  };

  return (
    <SidePanel closeLabel={t("close")} onClose={onClose} title={t("settings")}>

      <div className="settings-group">
        <h3>{t("appearance")}</h3>
        <section className="settings-card">
          <div className="settings-card-header">
            {theme === "dark" ? <Moon aria-hidden="true" size={23} /> : <Sun aria-hidden="true" size={23} />}
            <div>
              <strong>{t("appearance")}</strong>
              <p className="settings-detail">{t("appearanceDetail")}</p>
            </div>
          </div>
          <div className="theme-options">
            <button
              aria-pressed={theme === "dark"}
              className={theme === "dark" ? "selected" : ""}
              onClick={() => setUiTheme("dark")}
              type="button"
            >
              <Moon aria-hidden="true" size={16} /> {t("darkMode")}
            </button>
            <button
              aria-pressed={theme === "light"}
              className={theme === "light" ? "selected" : ""}
              onClick={() => setUiTheme("light")}
              type="button"
            >
              <Sun aria-hidden="true" size={16} /> {t("lightMode")}
            </button>
          </div>
        </section>
      </div>

      <div className="settings-group">
        <h3>{t("language")}</h3>
        <section className="settings-card">
          <div className="settings-card-header">
            <Globe2 aria-hidden="true" size={23} />
            <div>
              <strong>{t("language")}</strong>
              <p className="settings-detail">{t("languageDetail")}</p>
            </div>
          </div>
          <div className="language-options">
            <button
              aria-pressed={data.language === "en"}
              aria-busy={isPending && pendingLanguage === "en" || undefined}
              className={data.language === "en" ? "selected" : ""}
              disabled={isPending}
              onClick={() => changeLanguage("en")}
              type="button"
            >
              {isPending && pendingLanguage === "en" ? <ButtonLoader /> : null}
              {t("english")}
            </button>
            <button
              aria-pressed={data.language === "id"}
              aria-busy={isPending && pendingLanguage === "id" || undefined}
              className={data.language === "id" ? "selected" : ""}
              disabled={isPending}
              onClick={() => changeLanguage("id")}
              type="button"
            >
              {isPending && pendingLanguage === "id" ? <ButtonLoader /> : null}
              {t("indonesian")}
            </button>
          </div>
        </section>
      </div>

      <div className="settings-group">
        <h3>{t("relationshipTerminology")}</h3>
        <section className="settings-card">
          <div className="settings-card-header">
            <Languages aria-hidden="true" size={23} />
            <div>
              <strong>{t("relationshipTerminology")}</strong>
              <p className="settings-detail">{t("relationshipTerminologyDetail")}</p>
            </div>
          </div>
          <div className="language-options relationship-language-options">
            {relationshipLanguageOptions.map(([language, label]) => (
              <button
                aria-pressed={relationshipLanguage === language}
                className={relationshipLanguage === language ? "selected" : ""}
                key={language}
                onClick={() => actions.setRelationshipLanguage(language)}
                type="button"
              >
                {t(label)}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="privacy-note">
        <ShieldCheck aria-hidden="true" size={17} />
        <span><strong>{t("offlineReady")}</strong><br />{t("savedAutomatically")}</span>
      </div>
      <AppVersion />
    </SidePanel>
  );
}
