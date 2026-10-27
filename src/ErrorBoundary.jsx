import { Component } from "react";
import { Preferences } from "@capacitor/preferences";

/* Last line of defence: if a render ever throws, show the stored books as a download
   instead of a blank screen, so a bad state can never lock the user out of their data. */
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  download = async () => {
    let text = "";
    try { text = (await Preferences.get({ key: this.props.storageKey })).value || ""; } catch { /* fall back below */ }
    if (!text) { try { text = localStorage.getItem(this.props.storageKey) || ""; } catch { /* nothing stored */ } }
    if (!text) return alert("No saved books found on this device.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `finbuddy-rescue-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  render() {
    if (!this.state.error) return this.props.children;
    const b = { padding: "8px 14px", borderRadius: 8, border: "none", fontWeight: 600, cursor: "pointer", marginRight: 8 };
    return (
      <div role="alert" style={{ fontFamily: "system-ui", padding: 24, maxWidth: 520, margin: "40px auto", background: "#fff", borderRadius: 12, border: "1px solid #E3E8E1" }}>
        <div style={{ fontWeight: 800, fontSize: 18, color: "#0A2540", marginBottom: 8 }}>FinBuddy hit an error</div>
        <div style={{ fontSize: 13.5, color: "#1B2A38", lineHeight: 1.5, marginBottom: 12 }}>Your saved books have not been deleted. Download them now as a backup, then reload.</div>
        <pre style={{ fontSize: 11, background: "#F5F7F4", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap", color: "#9A3B2E" }}>{String(this.state.error?.message || this.state.error)}</pre>
        <button style={{ ...b, background: "#C8992E", color: "#0A2540" }} onClick={this.download}>Download saved books</button>
        <button style={{ ...b, background: "#0A2540", color: "#fff" }} onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
