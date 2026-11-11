import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { setLocale, locale } from './lib/i18n';
import './styles.css';

setLocale(locale.value, false);
createApp(App).use(router).mount('#app');
