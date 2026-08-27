import * as React from "react";
import * as ReactDOM from "react-dom/client";
// import { scan } from 'react-scan';
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { Home } from "./Home";
import { routes } from "./routes";
import "./index.css";

// Must run before React renders: https://react-scan.com/
// scan({ enabled: true, showToolbar: true });

const baseUrl = import.meta.env.BASE_URL;
const routerBase = baseUrl === "/" ? "" : baseUrl.replace(/\/$/, "");

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter basename={routerBase}>
            <App />
        </BrowserRouter>
    </React.StrictMode>,
);

export function App() {
    return (
        <div className="min-h-screen bg-gray-50 text-gray-900">
            <header className="border-b border-gray-200 bg-white/60 backdrop-blur sticky top-0 z-10">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
                    <Link className="flex items-center gap-3 text-lg font-semibold" to="/">
                        <img src={`${baseUrl}vite.svg`} alt="Vite logo" className="h-6 w-6" />
                        base-ui-masonry playground
                    </Link>
                    <nav className="flex items-center gap-2 text-sm">
                        <Link
                            to="/masonry"
                            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-100"
                        >
                            Masonry demo
                        </Link>
                        <Link
                            to="/perf/masonry"
                            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-100"
                        >
                            Perf benchmark
                        </Link>
                    </nav>
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-6 py-8">
                <Routes>
                    <Route path="/" element={<Home />} />
                    {routes.map((entry) => {
                        if (entry.type === "route") {
                            return (
                                <Route key={entry.path} path={entry.path} element={entry.element} />
                            );
                        }
                        if (entry.type === "redirect") {
                            return (
                                <Route
                                    key={entry.path}
                                    path={entry.path}
                                    element={<Navigate replace to={entry.to} />}
                                />
                            );
                        }
                        return null;
                    })}
                    <Route path="*" element={<NotFound />} />
                </Routes>
            </main>
        </div>
    );
}

function NotFound() {
    return (
        <div className="space-y-3">
            <h1 className="text-2xl font-semibold">Not found</h1>
            <p className="text-sm text-gray-700">
                This page doesn&apos;t exist.{" "}
                <Link to="/" className="hover:underline font-medium">
                    Go home
                </Link>
                .
            </p>
        </div>
    );
}
