import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./base.css";
import "./shell.css";
import "./canvas-actions.css";
import "./svg-canvas.css";
import "./dialogs.css";
import "./person-create.css";
import "@daypicker/react/style.css";
import "./date-picker.css";
import "./relationship.css";
import "./responsive.css";
import "./theme.css";
import "./access.css";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { LoginPage } from "./LoginPage";
import { SharedTreeApp } from "./SharedTreeApp";
import { AppProvider } from "./store";
import { applyUiTheme } from "./uiTheme";

applyUiTheme(document.documentElement);

if (/^\/auth\/email\/?$/u.test(window.location.pathname)) {
  window.history.replaceState(window.history.state, "", "/");
}

const isSharedRoute = /^\/s\/[^/]+\/?$/u.test(window.location.pathname);
const authRoute = /^\/login\/(admin|user)\/?$/u.exec(window.location.pathname);
const isStaging = __DEPLOYMENT_ENV__ === "staging";

function Application() {
  if (authRoute) return <LoginPage mode={authRoute[1] as "admin" | "user"} />;
  return (
    <AppProvider>
      {isSharedRoute ? <SharedTreeApp /> : <App />}
    </AppProvider>
  );
}

const application = <Application />;

if (isStaging) {
  document.title = "Soenarto Tree Staging | Test Data Only";
  document.documentElement.dataset.deploymentEnvironment = "staging";
  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      {isStaging ? (
      <div className="staging-shell">
        <aside className="staging-banner" role="note">
          <strong>Soenarto Tree Staging</strong>
          <span>Test data only. Data may be reset. Do not use this as your family archive.</span>
        </aside>
          <div className="staging-content">{application}</div>
      </div>
      ) : application}
    </AuthProvider>
  </StrictMode>
);
