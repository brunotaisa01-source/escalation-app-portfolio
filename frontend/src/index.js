import cssText from './styles.css';
import { renderApp } from './ui/app.js';

const style = document.createElement('style');
style.textContent = cssText;
document.head.append(style);
renderApp(document.querySelector('#app-root'));
