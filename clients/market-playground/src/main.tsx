import { createRoot } from "react-dom/client";

async function mount() {
  if (location.pathname === "/memory") history.replaceState(null, "", "/");
  const proposal = ["/proposal", "/proposal/"].includes(location.pathname);
  if (proposal) {
    document.documentElement.lang = "en";
    document.title =
      "Model fidelity in autonomous procurement · Private Market";
    const { default: Proposal } = await import("../../proposal/Proposal");
    createRoot(document.getElementById("root")!).render(<Proposal />);
  } else {
    const [{ default: App }] = await Promise.all([
      import("./App"),
      import("@wterm/react/css"),
      import("@fontsource/geist-mono/400.css"),
      import("@fontsource/geist-mono/500.css"),
      import("./style.css"),
    ]);
    createRoot(document.getElementById("root")!).render(<App />);
  }
}
void mount();
