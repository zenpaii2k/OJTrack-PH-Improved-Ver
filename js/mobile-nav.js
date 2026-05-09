(function () {
    // ─── DETERMINE ROLE FROM PATH ────────────────────────────
    const path     = window.location.pathname.toLowerCase();
    const isAdviser = path.includes('/supervisor/');

    // ─── NAV DEFINITIONS ─────────────────────────────────────
    const studentLinks = [
        { href: 'dashboard.html',    icon: '🏠', label: 'Home' },
        { href: 'ojtattendance.html', icon: '🕒', label: 'Logs' },
        { href: 'checklist.html',     icon: '✔️', label: 'Docs' },
        { href: 'generatepdf.html',   icon: '📄', label: 'Report' },
        { href: 'feedback.html',      icon: '💬', label: 'Feedback' },
    ];

    const adviserLinks = [
        { href: 'supervisordashboard.html',  icon: '🏠', label: 'Home' },
        { href: 'checkstudentdatabase.html', icon: '🕒', label: 'Logs' },
        { href: 'checkstudentreq.html',      icon: '✔️', label: 'Reqs' },
        { href: 'batchmanagement.html',      icon: '📁', label: 'Batch' },
        { href: 'checkstudentreports.html',  icon: '📄', label: 'Reports' },
    ];

    const links       = isAdviser ? adviserLinks : studentLinks;
    const currentFile = path.split('/').pop() || 'dashboard.html';

    // ─── BUILD HTML ──────────────────────────────────────────
    const nav = document.createElement('nav');
    nav.className   = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', 'Mobile navigation');

    nav.innerHTML = links.map(({ href, icon, label }) => {
        const isActive = currentFile === href || path.endsWith('/' + href);
        return `
            <a href="${href}"
               class="mob-nav-item${isActive ? ' active' : ''}"
               ${isActive ? 'aria-current="page"' : ''}>
                <span class="mob-nav-icon" aria-hidden="true">${icon}</span>
                <span>${label}</span>
            </a>`;
    }).join('');

    // ─── INJECT ──────────────────────────────────────────────
    document.body.appendChild(nav);
})();
