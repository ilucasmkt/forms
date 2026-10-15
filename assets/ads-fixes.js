/*
 * Ajustes da página de captação para rodar anúncios (Meta Ads).
 * Roda por cima da página já pronta, sem mexer no código dela:
 *  1. guarda de onde o visitante veio (UTMs, fbclid) e manda junto com o lead
 *  2. WhatsApp: máscara e só aceita celular brasileiro com DDD válido
 *  3. eventos do Pixel: "Lead" para todo envio e "CompleteRegistration" para o lead qualificado,
 *     com o mesmo event_id enviado ao webhook (pronto para a API de Conversões)
 *  4. quem não é qualificado não recebe o link de agendamento
 *  5. aviso de privacidade (LGPD) no formulário e no rodapé
 *  6. proteção simples contra robôs (campo-isca e tempo de preenchimento)
 */
(function () {
  'use strict';

  // ---- configuração ----
  var WEBHOOK_PATH = '/webhook/pipedrive';
  var PRIVACY_URL = '/privacidade.html';
  var PIXEL_NAME = 'Protocolo 5M';
  // Se o lead não for qualificado (não é dono, ou o investimento mínimo não faz sentido), esconde o Calendly
  var HIDE_BOOKING_FOR_UNQUALIFIED = true;
  var ATTRIBUTION_DAYS = 30;
  var STORE_KEY = 'ads_attribution_v1';
  var TRACK_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];

  var VALID_DDD = {};
  ('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 ' +
    '61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99')
    .split(' ')
    .forEach(function (d) {
      VALID_DDD[d] = true;
    });

  // ---------- utilidades ----------
  function digits(s) {
    return String(s || '').replace(/\D/g, '');
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function safeStorage(fn) {
    try {
      return fn(window.localStorage);
    } catch (e) {
      return null;
    }
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Celular brasileiro com DDD: 11 dígitos, DDD existente e começando em 9 (aceita +55 na frente) */
  function isValidBrMobile(value) {
    var d = digits(value);
    if (d.length === 13 && d.slice(0, 2) === '55') d = d.slice(2);
    return d.length === 11 && VALID_DDD[d.slice(0, 2)] === true && d.charAt(2) === '9';
  }

  function formatBrPhone(value) {
    var d = digits(value);
    if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length === 0) return '';
    if (d.length <= 2) return '(' + d;
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }

  // ---------- 1) origem do anúncio ----------
  function loadAttribution() {
    var raw = safeStorage(function (s) {
      return s.getItem(STORE_KEY);
    });
    if (!raw) return null;
    try {
      var saved = JSON.parse(raw);
      if (saved && Date.now() - saved.at < ATTRIBUTION_DAYS * 86400000) return saved;
    } catch (e) {
      /* dado antigo */
    }
    return null;
  }

  function captureAttribution() {
    var params = new URLSearchParams(window.location.search);
    var found = {};
    var any = false;
    TRACK_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) {
        found[k] = v.slice(0, 200);
        any = true;
      }
    });
    var saved = loadAttribution();
    // chegou por anúncio agora: vale a origem mais recente; senão, mantém a que já tinha (até 30 dias)
    if (any || !saved) {
      saved = { data: found, at: Date.now(), landing: window.location.href.slice(0, 500), referrer: (document.referrer || '').slice(0, 300) };
      safeStorage(function (s) {
        s.setItem(STORE_KEY, JSON.stringify(saved));
      });
    }
    return saved;
  }

  var attribution = captureAttribution();

  function metaCookies(data) {
    var fbp = readCookie('_fbp');
    var fbc = readCookie('_fbc');
    // o Pixel grava o _fbc sozinho; se ainda não gravou, monta a partir do fbclid
    if (!fbc && data.fbclid) fbc = 'fb.1.' + (attribution ? attribution.at : Date.now()) + '.' + data.fbclid;
    return { fbp: fbp, fbc: fbc };
  }

  // ---------- 3) Pixel: eventos com event_id ----------
  var lead = null; // { eventId, qualified }

  function wrapFbq() {
    var orig = window.fbq;
    if (typeof orig !== 'function' || orig.__adsWrapped) return;
    var wrapped = function () {
      var a = Array.prototype.slice.call(arguments);
      // o evento do lead qualificado leva o mesmo id (com sufixo) do envio, para deduplicar com a API de Conversões
      if (a[0] === 'track' && a[1] === 'CompleteRegistration' && a.length < 4 && lead) {
        a = [a[0], a[1], a[2] || {}, { eventID: lead.eventId + '-qualified' }];
      }
      return orig.apply(this, a);
    };
    for (var k in orig) {
      if (Object.prototype.hasOwnProperty.call(orig, k)) wrapped[k] = orig[k];
    }
    wrapped.__adsWrapped = true;
    window.fbq = wrapped;
  }
  wrapFbq();

  // ---------- 2 e 6) WhatsApp, isca e tempo de preenchimento ----------
  var formOpenedAt = 0;
  var setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function showPhoneError(input, message) {
    var box = input.parentElement;
    var el = box.querySelector('[data-ads-error]');
    if (!message) {
      if (el) el.remove();
      input.classList.remove('border-red-500');
      return;
    }
    if (!el) {
      el = document.createElement('p');
      el.setAttribute('data-ads-error', '');
      el.setAttribute('role', 'alert');
      el.className = 'text-red-400 text-xs mt-1.5';
      box.appendChild(el);
    }
    el.textContent = message;
    input.classList.add('border-red-500');
  }

  function enhancePhone(input) {
    if (input.__adsPhone) return;
    input.__adsPhone = true;
    input.setAttribute('inputmode', 'tel');
    input.setAttribute('autocomplete', 'tel-national');
    input.addEventListener('input', function () {
      var masked = formatBrPhone(input.value);
      showPhoneError(input, '');
      if (masked !== input.value) {
        // o formulário da página controla o campo: atualiza do jeito que ele percebe
        setValue.call(input, masked);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  function enhanceForm(form) {
    if (form.__adsForm) return;
    form.__adsForm = true;
    formOpenedAt = Date.now();

    // campo-isca: pessoa não vê, robô costuma preencher
    var trap = document.createElement('input');
    trap.type = 'text';
    trap.name = 'url_confirm';
    trap.tabIndex = -1;
    trap.autocomplete = 'off';
    trap.setAttribute('aria-hidden', 'true');
    trap.setAttribute('data-ads-trap', '');
    trap.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    form.appendChild(trap);

    var submit = form.querySelector('button[type="submit"]');
    if (submit && /falar no whatsapp/i.test(submit.textContent || '')) {
      // a tela seguinte não é o WhatsApp: o texto precisa dizer o que acontece de verdade
      submit.textContent = 'CONFIRMAR E CONTINUAR';
    }
    if (submit && !form.querySelector('[data-ads-consent]')) {
      var p = document.createElement('p');
      p.setAttribute('data-ads-consent', '');
      p.className = 'text-[11px] leading-snug text-slate-400 text-center mt-3';
      p.appendChild(document.createTextNode('Ao enviar, você concorda com o uso dos seus dados para contato comercial, conforme nossa '));
      var a = document.createElement('a');
      a.href = PRIVACY_URL;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'underline text-gold';
      a.textContent = 'Política de Privacidade';
      p.appendChild(a);
      p.appendChild(document.createTextNode('.'));
      submit.insertAdjacentElement('afterend', p);
    }
  }

  // não deixa enviar com WhatsApp inválido (roda antes do formulário da página)
  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      var tel = form.querySelector('input[type="tel"]');
      if (!tel) return;
      if (!isValidBrMobile(tel.value)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showPhoneError(tel, 'Digite um WhatsApp válido com DDD, ex.: (11) 91234-5678');
        tel.focus();
      }
    },
    true,
  );

  // ---------- envio do lead: enriquece o que vai para o webhook ----------
  function enrich(body) {
    var data = (attribution && attribution.data) || {};
    var cookies = metaCookies(data);
    var trap = document.querySelector('[data-ads-trap]');
    var qualified = body.cargo === 'Dono(a) da Loja' && /^sim/i.test(String(body.concordaValor || ''));
    var wa = digits(body.whatsapp);
    if (wa.length === 13 && wa.slice(0, 2) === '55') wa = wa.slice(2);

    var out = {};
    for (var k in body) {
      if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    }
    out.whatsapp_e164 = wa.length === 11 ? '55' + wa : '';
    out.qualificado = qualified;
    out.event_id = newId();
    out.page_url = window.location.href.slice(0, 500);
    out.landing_url = (attribution && attribution.landing) || '';
    out.referrer = (attribution && attribution.referrer) || document.referrer.slice(0, 300);
    out.user_agent = navigator.userAgent.slice(0, 300);
    out.fbp = cookies.fbp;
    out.fbc = cookies.fbc;
    out.tempo_preenchimento_s = formOpenedAt ? Math.round((Date.now() - formOpenedAt) / 1000) : null;
    out.suspeito_robo = Boolean((trap && trap.value) || (formOpenedAt && Date.now() - formOpenedAt < 2000));
    TRACK_KEYS.forEach(function (key) {
      out[key] = data[key] || '';
    });
    return out;
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf(WEBHOOK_PATH) !== -1 && init && typeof init.body === 'string') {
        var enriched = enrich(JSON.parse(init.body));
        lead = { eventId: enriched.event_id, qualified: enriched.qualificado, robot: enriched.suspeito_robo };
        init = Object.assign({}, init, { body: JSON.stringify(enriched) });
        if (!lead.robot && typeof window.fbq === 'function') {
          // todo cadastro é um Lead; o qualificado ainda dispara o CompleteRegistration da própria página
          window.fbq('track', 'Lead', { content_name: PIXEL_NAME, qualified: lead.qualified }, { eventID: lead.eventId });
        }
      }
    } catch (err) {
      /* nunca atrapalha o envio do lead */
    }
    return origFetch.call(this, input, init);
  };

  // ---------- 4 e 5) telas: confirmação e rodapé ----------
  function adjustConfirmation() {
    if (!HIDE_BOOKING_FOR_UNQUALIFIED || !lead || lead.qualified) return;
    var root = document.getElementById('root');
    if (!root) return;
    var booking = root.querySelector('a[href*="calendly.com"]');
    if (!booking || booking.getAttribute('data-ads-hidden')) return;
    booking.setAttribute('data-ads-hidden', '1');
    booking.style.display = 'none';
    var container = booking.parentElement;
    if (!container) return;
    var video = container.querySelector('iframe');
    if (video) {
      var holder = video.parentElement;
      if (holder) holder.style.display = 'none';
    }
    var heading = container.querySelector('h2');
    if (heading) heading.textContent = 'Recebemos o seu contato';
    var paragraphs = container.querySelectorAll('p');
    for (var i = 0; i < paragraphs.length; i++) {
      if (/agende agora/i.test(paragraphs[i].textContent || '')) {
        paragraphs[i].textContent =
          'Nosso time vai avaliar as suas respostas. Se o Protocolo 5M fizer sentido para o momento da sua loja, entramos em contato pelo WhatsApp.';
      }
    }
  }

  function addFooterLink() {
    var footer = document.querySelector('footer');
    if (!footer || footer.querySelector('[data-ads-privacy]')) return;
    var wrap = document.createElement('p');
    wrap.setAttribute('data-ads-privacy', '');
    wrap.className = 'text-xs text-slate-500 mt-3 text-center';
    var a = document.createElement('a');
    a.href = PRIVACY_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'underline hover:text-slate-300';
    a.textContent = 'Política de Privacidade';
    wrap.appendChild(a);
    footer.appendChild(wrap);
  }

  var scheduled = false;
  function scan() {
    scheduled = false;
    wrapFbq(); // caso o Pixel tenha sido recriado
    var tel = document.querySelector('input[type="tel"]');
    if (tel) {
      enhancePhone(tel);
      var form = tel.closest('form');
      if (form) enhanceForm(form);
    }
    adjustConfirmation();
    addFooterLink();
  }

  new MutationObserver(function () {
    if (!scheduled) {
      scheduled = true;
      window.requestAnimationFrame(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // para testes
  window.__adsFixes = { isValidBrMobile: isValidBrMobile, formatBrPhone: formatBrPhone };
})();
