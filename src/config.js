// Hosted demo build (VITE_DEMO=1): starts on synthetic sample books, under its own key.
export const DEMO = import.meta.env.VITE_DEMO === "1";
export const KEY = DEMO ? "finbuddy_demo_db_v2" : "finbuddy_db_v2";
