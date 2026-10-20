import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { bootChats } from "./lib/store";

const savedTheme = localStorage.getItem("alter.theme");
if (savedTheme === "light") document.documentElement.dataset.theme = "light";

void bootChats().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
);
