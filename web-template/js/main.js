// ============================================================
// main.js — Shared JavaScript for PodoSystem web de citas
// ============================================================

(function () {
  'use strict';

  // ─── Hamburger Menu ──────────────────────────────────────
  const hamburger = document.querySelector('.hamburger');
  const navMenu = document.querySelector('.nav-menu');

  if (hamburger && navMenu) {
    hamburger.addEventListener('click', () => {
      const isOpen = hamburger.classList.toggle('open');
      navMenu.classList.toggle('open', isOpen);
      hamburger.setAttribute('aria-expanded', isOpen);
    });

    // Close menu when a nav link is clicked
    navMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('open');
        navMenu.classList.remove('open');
        hamburger.setAttribute('aria-expanded', false);
      });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!hamburger.contains(e.target) && !navMenu.contains(e.target)) {
        hamburger.classList.remove('open');
        navMenu.classList.remove('open');
        hamburger.setAttribute('aria-expanded', false);
      }
    });
  }

  // ─── Header Shadow on Scroll ─────────────────────────────
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => {
      header.classList.toggle('scrolled', window.scrollY > 20);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ─── Active Nav Link ─────────────────────────────────────
  (function markActiveLink() {
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-menu a').forEach(link => {
      const href = link.getAttribute('href');
      if (href === currentFile || (currentFile === '' && href === 'index.html')) {
        link.classList.add('active');
      }
    });
  })();

  // ─── Smooth Scroll for Anchor Links ──────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        const headerHeight = header ? header.offsetHeight : 0;
        const targetTop = target.getBoundingClientRect().top + window.scrollY - headerHeight - 20;
        window.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
    });
  });

  // ─── Review Stars Renderer ───────────────────────────────
  function renderStars(count, container) {
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const star = document.createElement('span');
      star.className = 'star' + (i < count ? ' filled' : '');
      star.textContent = '★';
      container.appendChild(star);
    }
  }

  document.querySelectorAll('[data-stars]').forEach(el => {
    renderStars(parseInt(el.dataset.stars, 10) || 5, el);
  });

  // ─── Scroll Reveal Animation ─────────────────────────────
  function initScrollReveal() {
    const elements = document.querySelectorAll('.fade-up');
    if (!elements.length) return;

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

      elements.forEach(el => observer.observe(el));
    } else {
      elements.forEach(el => el.classList.add('visible'));
    }
  }


  // ─── WhatsApp Button Pulse on Hover ──────────────────────
  const waBtn = document.querySelector('.whatsapp-btn');
  if (waBtn) {
    waBtn.addEventListener('mouseenter', () => waBtn.classList.add('hover'));
    waBtn.addEventListener('mouseleave', () => waBtn.classList.remove('hover'));
  }

  // ─── Init ─────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initScrollReveal();
  });

  // If DOM is already ready
  if (document.readyState !== 'loading') {
    initScrollReveal();
  }

})();
