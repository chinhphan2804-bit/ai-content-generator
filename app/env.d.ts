/// <reference types="@react-router/dev" />
/// <reference types="vite/client" />

declare global {
  namespace JSX {
    interface IntrinsicElements {
      's-page': any;
      's-layout': any;
      's-layout-section': any;
      's-card': any;
      's-section': any;
      's-text': any;
      's-button': any;
      's-text-field': any;
      's-select': any;
      's-banner': any;
      's-divider': any;
      's-spinner': any;
      'ui-title-bar': any;
      'ui-nav-menu': any;
    }
  }
}

export {};
