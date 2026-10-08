import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';
import './style.css';

const vuetify = createVuetify({
  components, directives,
  theme: { defaultTheme: 'filesync', themes: { filesync: { dark: false, colors: {
    primary: '#0E7C78', secondary: '#173047', surface: '#FFFFFF', background: '#F3F7F8', error: '#B53B3B', warning: '#9B6100', success: '#167B60',
  } } } },
  defaults: { VBtn: { rounded: 'lg', elevation: 0 }, VCard: { rounded: 'xl', elevation: 0 }, VTextField: { density: 'comfortable', variant: 'outlined' } },
});
createApp(App).use(vuetify).mount('#app');
