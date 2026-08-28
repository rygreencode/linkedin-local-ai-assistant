/* Shared constants. Classic script: assigns to globalThis so it can be listed
   in content_scripts (which cannot use ES modules) and <script src> alike. */
globalThis.LLA_DEFAULT_SETTINGS = {
  endpoint: 'http://localhost:11434',
  model: 'qwen2.5:3b',
  lightModel: 'qwen2.5:1.5b',
  watchdogMs: 2500,
  hardTimeoutMs: 20000,
  name: '',
  company: '',
  bio: '',
  offer: '',
  bookingLink: 'https://meetings-eu1.hubspot.com/ryan-green3/letstalkantler',
  guidelines: 'Keep replies under 3 sentences. Warm but direct. Never invent facts about the recipient.',
  styleSamples: [],
  selectorOverrides: {},
  showShortcutHint: true,
  autoStartOllama: true,
  autoStopOllama: true,
  autoStopGraceMin: 5,
  keepAlive: '5m',
  debug: false
};

/* Tiered selectors, most-specific first. Tier 0 = LinkedIn's current CSS classes,
   later tiers = semantic ARIA/structural attributes that survive class churn.
   A user override (from the element picker) is tried ahead of all of these. */
globalThis.LLA_SELECTOR_TIERS = {
  chatInput: [
    'div.msg-form__contenteditable[contenteditable="true"]',
    'form.msg-form div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]'
  ],
  threadContainer: [
    'div.msg-s-message-list-container',
    'div.msg-s-message-list',
    'div[role="main"] ul.msg-s-message-list-content'
  ],
  messageNode: [
    'li.msg-s-message-list__event',
    'div.msg-s-event-listitem',
    'div[role="main"] div[role="article"]'
  ],
  headerName: [
    'h2.msg-entity-lockup__entity-title',
    'div.msg-title-bar h2',
    'a.msg-thread__link-to-profile'
  ],
  headerSubtitle: [
    'div.msg-entity-lockup__entity-info',
    'p.msg-entity-lockup__entity-info',
    'div.msg-title-bar p'
  ],
  mainContainer: [
    '.msg__container',
    '.scaffold-layout__content',
    'div[role="main"]',
    'main'
  ],
  conversationItem: [
    'li.msg-conversation-listitem',
    'li.msg-conversations-container__convo-item',
    'ul.msg-conversations-container__conversations-list > li',
    '.msg-conversations-container__conversations-list li',
    'div[role="main"] ul li'
  ],
  unreadFilter: [
    'button[aria-label="Unread"]',
    'button[aria-label*="Unread" i]',
    '.msg-conversations-container__filters button[role="radio"]'
  ],
  formAnchor: [
    'form.msg-form',
    'div.msg-form',
    'div[contenteditable="true"][role="textbox"]'
  ]
};

globalThis.LLA_SELECTOR_LABELS = {
  chatInput: 'Chat input',
  threadContainer: 'Message list',
  messageNode: 'Message bubble',
  headerName: 'Recipient name',
  headerSubtitle: 'Recipient headline',
  formAnchor: 'Compose box (UI anchor)',
  unreadFilter: 'Unread filter',
  conversationItem: 'Conversation list item',
  mainContainer: 'Main content column'
};
