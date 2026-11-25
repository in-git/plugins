import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import 'aieditor/style.css';
import './editor.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
