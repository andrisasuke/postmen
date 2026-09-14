import { createApp } from "vue";
import { createPinia } from "pinia";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/fira-code/latin-400.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/workspace.css";
import App from "./app/App.vue";

createApp(App).use(createPinia()).mount("#app");
