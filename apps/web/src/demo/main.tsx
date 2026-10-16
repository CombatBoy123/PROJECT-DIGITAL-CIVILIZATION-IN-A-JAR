// Must come first: switches off Zod's eval probe before any schema is constructed.
import './csp';
// CSP-safe PixiJS: replaces the shader and uniform code generators that use
// `new Function`. Must be imported before PixiJS renders anything.
import 'pixi.js/unsafe-eval';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import { DemoApp } from './DemoApp';
import './demo.css';

/*
 * Entry of the standalone browser demo (demo.html, built into one self-contained
 * HTML fragment by scripts/build-demo-artifact.mjs).
 */

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
