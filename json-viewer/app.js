function formatColumnLabel(col) {
    return col.replaceAll('_', ' ');
}

function getPolicyDecisionClass(decision) {
    const normalized = decision.toLowerCase();
    if (normalized === 'allow') {
        return 'success';
    }
    if (normalized === 'bypass') {
        return 'warning';
    }
    return 'danger';
}

function formatLocalDateTime(val) {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) {
        return String(val);
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

// Translate a single Access rule object ({ type: {...} }) into a human-readable sentence.
// ctx provides id-to-name resolvers: { groupName, idpName }.
function describeRule(rule, ctx) {
    const key = Object.keys(rule)[0];
    if (!key) {
        return JSON.stringify(rule);
    }
    const val = rule[key] || {};
    switch (key) {
        case 'email': return `Email is ${val.email}`;
        case 'email_domain': return `Emails ending in @${val.domain}`;
        case 'email_list': return `Email in list ${val.id}`;
        case 'everyone': return 'Everyone';
        case 'certificate': return 'Valid client certificate';
        case 'common_name': return `Certificate CN is ${val.common_name}`;
        case 'ip': return `IP in ${val.ip}`;
        case 'ip_list': return `IP in list ${val.id}`;
        case 'group': return `Member of group "${ctx.groupName(val.id)}"`;
        case 'geo': return `Country is ${val.country_code}`;
        case 'auth_method': return `Auth method is ${val.auth_method}`;
        case 'login_method': return `Login via ${ctx.idpName(val.id)}`;
        case 'service_token': return `Service token ${val.token_id}`;
        case 'any_valid_service_token': return 'Any valid service token';
        case 'device_posture': return `Device posture check ${val.integration_uid}`;
        case 'external_evaluation': return `External evaluation at ${val.evaluate_url}`;
        case 'azureAD': return `Entra ID group ${val.id}`;
        case 'gsuite': return `Google Workspace group ${val.email}`;
        case 'github-organization': return `GitHub org ${val.name}${val.team ? ` team ${val.team}` : ''}`;
        case 'okta': return `Okta group ${val.name || val.email || val.id}`;
        case 'saml': return `SAML attribute ${val.attribute_name} = ${val.attribute_value}`;
        case 'auth_context': return `Entra auth context ${val.ac_id || val.id}`;
        default: return `${key}: ${JSON.stringify(val)}`;
    }
}

const RULE_SECTIONS = [
    { field: 'include', label: 'Include (any of)' },
    { field: 'require', label: 'Require (all of)' },
    { field: 'exclude', label: 'Exclude' },
];

// Build the readable Include / Require / Exclude sections for a policy.
// Returns null when the policy has no rule arrays to show.
function buildRuleSections(policy, ctx) {
    const container = document.createElement('div');
    let hasRules = false;

    for (const { field, label } of RULE_SECTIONS) {
        const rules = policy[field];
        if (!Array.isArray(rules) || rules.length === 0) {
            continue;
        }
        hasRules = true;

        const section = document.createElement('div');
        section.className = `rule-section rule-${field}`;

        const heading = document.createElement('h4');
        heading.className = 'rule-section-title';
        heading.textContent = label;
        section.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'rule-list';
        for (const rule of rules) {
            const li = document.createElement('li');
            li.className = 'rule-item';
            li.textContent = describeRule(rule, ctx);
            list.appendChild(li);
        }
        section.appendChild(list);
        container.appendChild(section);
    }

    return hasRules ? container : null;
}

function createTagSpan(text, extraClass = '') {
    const span = document.createElement('span');
    span.className = extraClass ? `tag ${extraClass}` : 'tag';
    span.textContent = text;
    return span;
}

function createPolicyBlock(name, badgeText = '', badgeClass = '', tooltipText = '', kind = '') {
    const root = document.createElement('div');
    root.className = 'policy-block';
    if (kind) {
        root.dataset.kind = kind;
    }
    if (tooltipText) {
        root.dataset.json = tooltipText;
        // Keep title for minimal browser native hover indicator but can be empty or set
        root.title = "Click to view full details";
    }

    const header = document.createElement('div');
    header.className = 'policy-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'policy-name';
    nameSpan.textContent = name;
    header.appendChild(nameSpan);

    if (badgeText) {
        header.appendChild(createTagSpan(badgeText, badgeClass));
    }

    root.appendChild(header);
    return root;
}

function getHeaderLabel(col) {
    if (col === 'updated_at') {
        return 'Updated At (Local Time)';
    }
    if (col === 'tags') {
        return 'Tags';
    }
    return formatColumnLabel(col);
}

function renderPoliciesCell(td, val, row, resolvePolicy) {
    if (row && row.policies_error) {
        td.appendChild(createTagSpan('POLICIES UNAVAILABLE', 'danger'));
        return;
    }
    for (const policy of val) {
        const resolved = resolvePolicy(policy);
        const decision = resolved.decision || 'unknown';
        const decisionClass = getPolicyDecisionClass(decision);
        const name = resolved.name || 'Unnamed Policy';
        const tooltip = JSON.stringify(resolved, null, 2);
        td.appendChild(createPolicyBlock(name, decision.toUpperCase(), decisionClass, tooltip, 'policy'));
    }
}

function renderDestinationsCell(td, val) {
    for (const dest of val) {
        const type = dest.type || 'unknown';
        const name = dest.uri || dest.cidr || dest.hostname || dest.ip || JSON.stringify(dest);
        const tooltip = JSON.stringify(dest, null, 2);
        td.appendChild(createPolicyBlock(name, type.toUpperCase(), '', tooltip));
    }
}

function renderDomainsCell(td, val) {
    for (const domain of val) {
        const domainName = typeof domain === 'string' ? domain : JSON.stringify(domain);
        td.appendChild(createPolicyBlock(domainName));
    }
}

function renderIdpTagsCell(td, val, resolveIdpName) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'tag-wrap';
    for (const id of val) {
        tagWrap.appendChild(createTagSpan(resolveIdpName(id)));
    }
    td.appendChild(tagWrap);
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('search-input');
    const idpFilter = document.getElementById('idp-filter');
    const tagFilter = document.getElementById('tag-filter');
    const tableHeadRow = document.getElementById('table-head-row');
    const tableBody = document.getElementById('table-body');
    const paginationContainer = document.getElementById('pagination');
    const perPageSelect = document.getElementById('per-page-select');
    const columnToggleBtn = document.getElementById('column-toggle-btn');
    const columnToggleContent = document.getElementById('column-toggle-content');
    const columnToggleSection = document.querySelector('.column-toggle-section');

    // API Integration & Setup Screen Elements
    const setupScreen = document.getElementById('setup-screen');
    const mainContent = document.querySelector('.main-content');
    const setupForm = document.getElementById('setup-form');
    const apiTokenInput = document.getElementById('api-token');
    const accountIdInput = document.getElementById('account-id');
    const accountSelectorGroup = document.getElementById('account-selector-group');
    const accountSelect = document.getElementById('account-select');
    const setupError = document.getElementById('setup-error');
    const connectBtn = document.getElementById('connect-btn');
    const toggleTokenVisibility = document.getElementById('toggle-token-visibility');
    const accountNameDisplay = document.getElementById('account-name-display');
    const refreshBtn = document.getElementById('refresh-btn');
    const disconnectBtn = document.getElementById('disconnect-btn');

    let allData = [];
    let filteredData = [];
    let columns = [];
    let visibleColumns = [];
    let currentPage = 1;
    let itemsPerPage = 10;
    let idpMap = {};
    let groupMap = {};
    let reusablePolicyMap = {};
    let currentSortColumn = null;
    let isSortAscending = true;
    let draggedColumn = null;
    let accountsList = [];

    // Toggle API token field visibility
    toggleTokenVisibility.addEventListener('click', () => {
        const isPassword = apiTokenInput.type === 'password';
        apiTokenInput.type = isPassword ? 'text' : 'password';
        const eyeIcon = toggleTokenVisibility.querySelector('svg');
        if (isPassword) {
            eyeIcon.style.color = 'var(--accent-color)';
        } else {
            eyeIcon.style.color = '';
        }
    });

    // Details Modal Logic & Delegation
    const detailsModal = document.getElementById('details-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalRules = document.getElementById('modal-rules');
    const modalRawDetails = document.getElementById('modal-raw-details');
    const modalCode = document.getElementById('modal-code');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalCopyBtn = document.getElementById('modal-copy-btn');
    const copyBtnText = document.getElementById('copy-btn-text');
    let currentModalJson = '';

    function openModal(title, jsonStr, kind = '') {
        modalTitle.textContent = title;
        let parsed = null;
        try {
            parsed = JSON.parse(jsonStr);
            currentModalJson = JSON.stringify(parsed, null, 2);
        } catch (e) {
            currentModalJson = jsonStr;
        }

        // For policies, show readable rules; raw JSON goes in a collapsible section.
        modalRules.replaceChildren();
        let sections = null;
        if (kind === 'policy' && parsed) {
            sections = buildRuleSections(parsed, {
                groupName: getGroupDisplayName,
                idpName: getIdpDisplayName,
            });
        }
        if (sections) {
            modalRules.appendChild(sections);
            modalRawDetails.open = false;
        } else {
            modalRawDetails.open = true;
        }

        modalCode.textContent = currentModalJson;
        detailsModal.classList.remove('hidden');
        copyBtnText.textContent = 'Copy JSON';
        const copyIcon = modalCopyBtn.querySelector('svg');
        if (copyIcon) copyIcon.style.color = '';
    }

    function closeModal() {
        detailsModal.classList.add('hidden');
    }

    modalCloseBtn.addEventListener('click', closeModal);
    detailsModal.querySelector('.modal-overlay').addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !detailsModal.classList.contains('hidden')) {
            closeModal();
        }
    });

    modalCopyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(currentModalJson);
            copyBtnText.textContent = 'Copied!';
            const copyIcon = modalCopyBtn.querySelector('svg');
            if (copyIcon) copyIcon.style.color = 'var(--success)';
            setTimeout(() => {
                copyBtnText.textContent = 'Copy JSON';
                if (copyIcon) copyIcon.style.color = '';
            }, 2000);
        } catch (err) {
            console.error('Failed to copy configurations: ', err);
        }
    });

    document.addEventListener('click', (e) => {
        const block = e.target.closest('.policy-block');
        if (block && block.dataset.json) {
            e.stopPropagation();
            const nameEl = block.querySelector('.policy-name');
            const title = nameEl ? nameEl.textContent : 'Configuration Details';
            openModal(title, block.dataset.json, block.dataset.kind || '');
        }
    });

    // Check credentials on startup
    checkCredentials();

    setupForm.addEventListener('submit', handleConnect);
    refreshBtn.addEventListener('click', handleRefresh);
    disconnectBtn.addEventListener('click', handleDisconnect);
    searchInput.addEventListener('input', handleFilters);
    idpFilter.addEventListener('change', handleFilters);
    tagFilter.addEventListener('change', handleFilters);

    perPageSelect.addEventListener('change', (e) => {
        itemsPerPage = Number.parseInt(e.target.value, 10);
        currentPage = 1;
        renderTable();
    });

    columnToggleBtn.addEventListener('click', () => {
        columnToggleSection.classList.toggle('show');
    });

    globalThis.addEventListener('click', (e) => {
        if (!e.target.closest('.column-toggle-section')) {
            columnToggleSection.classList.remove('show');
        }
    });

    function checkCredentials() {
        const token = sessionStorage.getItem('cf_api_token');
        const accountId = sessionStorage.getItem('cf_account_id');
        const accountName = sessionStorage.getItem('cf_account_name');

        if (token && accountId) {
            setupScreen.classList.add('hidden');
            mainContent.classList.remove('hidden');
            accountNameDisplay.textContent = accountName || accountId;
            loadData(token, accountId);
        } else {
            setupScreen.classList.remove('hidden');
            mainContent.classList.add('hidden');
        }
    }

    async function handleConnect(e) {
        e.preventDefault();

        const token = apiTokenInput.value.trim();
        let accountId = accountIdInput.value.trim();

        if (accountSelect.value) {
            accountId = accountSelect.value;
        }

        if (!token) {
            showError('API Token is required');
            return;
        }

        setLoading(true);
        showError('');

        try {
            // If no account ID is specified, retrieve accounts using token
            if (!accountId) {
                const response = await fetch('/api/accounts', {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.errors?.[0]?.message || 'Failed to authenticate token or fetch accounts');
                }

                accountsList = data.result || [];

                if (accountsList.length === 0) {
                    throw new Error('No accounts found for this API token. Ensure it has the "Account Settings: Read" permission.');
                }

                if (accountsList.length === 1) {
                    // Exactly one account - use it immediately
                    accountId = accountsList[0].id;
                    const accountName = accountsList[0].name || accountId;
                    sessionStorage.setItem('cf_api_token', token);
                    sessionStorage.setItem('cf_account_id', accountId);
                    sessionStorage.setItem('cf_account_name', accountName);

                    checkCredentials();
                } else {
                    // Multiple accounts - show selector dropdown
                    accountSelect.replaceChildren();
                    const defaultOpt = document.createElement('option');
                    defaultOpt.value = '';
                    defaultOpt.textContent = '-- Select Account --';
                    accountSelect.appendChild(defaultOpt);

                    for (const acc of accountsList) {
                        const opt = document.createElement('option');
                        opt.value = acc.id;
                        opt.textContent = acc.name || acc.id;
                        accountSelect.appendChild(opt);
                    }

                    accountSelectorGroup.classList.remove('hidden');
                    setLoading(false);
                }
            } else {
                // Account ID provided (or selected) - test loading data
                const response = await fetch(`/api/data?account_id=${accountId}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.errors?.[0]?.message || 'Failed to fetch Zero Trust data for this account');
                }

                // Resolve account name
                let accountName = accountId;
                if (accountsList.length > 0) {
                    const match = accountsList.find(a => a.id === accountId);
                    if (match) accountName = match.name;
                } else {
                    try {
                        const accRes = await fetch('/api/accounts', {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const accData = await accRes.json();
                        if (accRes.ok && accData.success) {
                            const match = accData.result?.find(a => a.id === accountId);
                            if (match) accountName = match.name;
                        }
                    } catch (err) {
                        console.warn('Could not resolve account name', err);
                    }
                }

                sessionStorage.setItem('cf_api_token', token);
                sessionStorage.setItem('cf_account_id', accountId);
                sessionStorage.setItem('cf_account_name', accountName);

                checkCredentials();
            }
        } catch (err) {
            console.error(err);
            showError(err.message);
            setLoading(false);
        }
    }

    async function loadData(token, accountId) {
        setLoading(true);
        refreshBtn.disabled = true;

        try {
            const response = await fetch(`/api/data?account_id=${accountId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.status === 401 || response.status === 403) {
                handleDisconnect();
                showError('Session expired or token invalid. Please reconnect.');
                return;
            }

            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.errors?.[0]?.message || 'Failed to retrieve Zero Trust data');
            }

            allData = data.result?.apps || [];

            // Rebuild Identity Providers map
            idpMap = {};
            const idps = data.result?.idps || [];
            for (const item of idps) {
                if (item.id) {
                    idpMap[item.id] = item.name || item.type || item.id;
                }
            }

            // Access Groups map (rule group IDs -> names)
            groupMap = {};
            const groups = data.result?.groups || [];
            for (const item of groups) {
                if (item.id) {
                    groupMap[item.id] = item.name || item.id;
                }
            }

            // Account-level reusable policies (id -> full definition)
            reusablePolicyMap = {};
            const reusablePolicies = data.result?.reusable_policies || [];
            for (const item of reusablePolicies) {
                if (item.id) {
                    reusablePolicyMap[item.id] = item;
                }
            }

            if (allData.length === 0) {
                showEmptyState('No Zero Trust Applications found in this account.', false);
            } else {
                initData();
            }
        } catch (err) {
            console.error(err);
            showEmptyState(`Error fetching Zero Trust configurations: ${err.message}`, true);
        } finally {
            setLoading(false);
            refreshBtn.disabled = false;
        }
    }

    function handleRefresh() {
        const token = sessionStorage.getItem('cf_api_token');
        const accountId = sessionStorage.getItem('cf_account_id');
        if (token && accountId) {
            loadData(token, accountId);
        }
    }

    function handleDisconnect() {
        sessionStorage.removeItem('cf_api_token');
        sessionStorage.removeItem('cf_account_id');
        sessionStorage.removeItem('cf_account_name');

        allData = [];
        filteredData = [];
        idpMap = {};
        groupMap = {};
        reusablePolicyMap = {};
        accountsList = [];

        apiTokenInput.value = '';
        accountIdInput.value = '';
        accountSelect.value = '';
        accountSelectorGroup.classList.add('hidden');
        showError('');

        checkCredentials();
    }

    function setLoading(isLoading) {
        const spinner = connectBtn.querySelector('.spinner-small');
        const btnText = connectBtn.querySelector('.btn-text');

        if (isLoading) {
            connectBtn.disabled = true;
            if (spinner) spinner.classList.remove('hidden');
            if (btnText) btnText.textContent = 'Connecting...';
        } else {
            connectBtn.disabled = false;
            if (spinner) spinner.classList.add('hidden');
            if (btnText) btnText.textContent = 'Connect to API';
        }
    }

    function showError(msg) {
        if (msg) {
            setupError.textContent = msg;
            setupError.classList.remove('hidden');
        } else {
            setupError.textContent = '';
            setupError.classList.add('hidden');
        }
    }

    function getIdpDisplayName(id) {
        if (id in idpMap) {
            return idpMap[id];
        }
        return id;
    }

    function getGroupDisplayName(id) {
        if (id in groupMap) {
            return groupMap[id];
        }
        return id;
    }

    // Reusable policies attached to apps may come back as id-only references;
    // merge in the account-level definition so rules can render.
    function resolvePolicy(policy) {
        const hasRules = Array.isArray(policy.include) || Array.isArray(policy.exclude) || Array.isArray(policy.require);
        if (!hasRules && policy.id && policy.id in reusablePolicyMap) {
            return { ...reusablePolicyMap[policy.id], ...policy, reusable: true };
        }
        return policy;
    }

    function setDefaultFilterOption(select, label) {
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = label;
        select.appendChild(option);
    }

    function renderArrayColumn(td, col, val, row) {
        if ((col === 'allowed_idps' || col === 'tags') && Array.isArray(val)) {
            renderIdpTagsCell(td, val, getIdpDisplayName);
            return true;
        }
        if (col === 'policies' && Array.isArray(val)) {
            renderPoliciesCell(td, val, row, resolvePolicy);
            return true;
        }
        if (col === 'destinations' && Array.isArray(val)) {
            renderDestinationsCell(td, val);
            return true;
        }
        if (col === 'self_hosted_domains' && Array.isArray(val)) {
            renderDomainsCell(td, val);
            return true;
        }
        return false;
    }

    function renderCellContent(td, col, val, row) {
        if (val === null || val === undefined) {
            td.textContent = '-';
            td.style.color = 'var(--text-secondary)';
            return;
        }

        if (col === 'updated_at' || col === 'created_at') {
            td.textContent = formatLocalDateTime(val);
            return;
        }

        if (typeof val === 'boolean') {
            td.appendChild(createTagSpan(val ? 'True' : 'False', val ? 'success' : 'danger'));
            return;
        }

        if (renderArrayColumn(td, col, val, row)) {
            return;
        }

        if (typeof val === 'object') {
            td.textContent = JSON.stringify(val);
            td.title = JSON.stringify(val, null, 2);
            return;
        }

        td.textContent = String(val);
        td.title = String(val);
    }

    function initData() {
        const firstItem = allData[0] || {};
        // policies_error is an internal flag rendered inside the policies cell, not a column
        columns = Object.keys(firstItem).filter((col) => col !== 'policies_error');

        const defaultRequested = ['name', 'destinations', 'tags', 'allowed_idps', 'policies', 'updated_at'];
        const hasDefaults = defaultRequested.some((col) => columns.includes(col));

        visibleColumns = hasDefaults
            ? defaultRequested.filter((col) => columns.includes(col))
            : [...columns];

        filteredData = [...allData];
        currentPage = 1;
        currentSortColumn = null;
        isSortAscending = true;
        searchInput.disabled = false;
        searchInput.value = '';
        perPageSelect.disabled = false;
        columnToggleBtn.disabled = false;
        idpFilter.disabled = false;
        tagFilter.disabled = false;

        populateFilters();
        renderColumnToggles();
        renderHeaders();
        renderTable();
    }

    function populateFilters() {
        const uniqueIdps = new Set();
        const uniqueTags = new Set();

        for (const row of allData) {
            if (row.allowed_idps && Array.isArray(row.allowed_idps)) {
                for (const id of row.allowed_idps) {
                    uniqueIdps.add(id);
                }
            }
            if (row.tags && Array.isArray(row.tags)) {
                for (const tag of row.tags) {
                    uniqueTags.add(tag);
                }
            }
        }

        setDefaultFilterOption(idpFilter, 'All IdPs');
        const idpList = Array.from(uniqueIdps, (id) => ({ id, name: getIdpDisplayName(id) }));
        idpList.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of idpList) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            idpFilter.appendChild(option);
        }

        setDefaultFilterOption(tagFilter, 'All Tags (IdPs)');
        const tagList = Array.from(uniqueTags, (tag) => ({ id: tag, name: getIdpDisplayName(tag) }));
        tagList.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of tagList) {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            tagFilter.appendChild(option);
        }
    }

    function onColumnToggleChange(col) {
        return (e) => {
            if (e.target.checked) {
                visibleColumns.push(col);
                visibleColumns.sort((a, b) => columns.indexOf(a) - columns.indexOf(b));
            } else {
                visibleColumns = visibleColumns.filter((c) => c !== col);
            }
            renderHeaders();
            renderTable();
        };
    }

    function renderColumnToggles() {
        columnToggleContent.replaceChildren();
        for (const col of columns) {
            const label = document.createElement('label');
            label.className = 'toggle-label';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'toggle-checkbox';
            checkbox.value = col;
            checkbox.checked = visibleColumns.includes(col);
            checkbox.addEventListener('change', onColumnToggleChange(col));

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${formatColumnLabel(col)}`));
            columnToggleContent.appendChild(label);
        }
    }

    function onHeaderDrop(targetColumn) {
        return (e) => {
            e.stopPropagation();
            const targetTh = e.target.closest('th');
            if (!targetTh) {
                return;
            }

            targetTh.classList.remove('drag-over');
            if (draggedColumn && draggedColumn !== targetColumn) {
                const fromIndex = visibleColumns.indexOf(draggedColumn);
                const toIndex = visibleColumns.indexOf(targetColumn);
                visibleColumns.splice(fromIndex, 1);
                visibleColumns.splice(toIndex, 0, draggedColumn);
                renderHeaders();
                renderTable();
            }
        };
    }

    function attachHeaderDragHandlers(th, col) {
        th.addEventListener('dragstart', (e) => {
            draggedColumn = col;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        th.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });

        th.addEventListener('dragenter', (e) => {
            const targetTh = e.target.closest('th');
            if (targetTh && targetTh.dataset.column !== draggedColumn) {
                targetTh.classList.add('drag-over');
            }
        });

        th.addEventListener('dragleave', (e) => {
            const targetTh = e.target.closest('th');
            if (targetTh) {
                targetTh.classList.remove('drag-over');
            }
        });

        th.addEventListener('dragend', (e) => {
            e.target.classList.remove('dragging');
        });

        th.addEventListener('drop', onHeaderDrop(col));
    }

    function renderHeaders() {
        tableHeadRow.replaceChildren();
        for (const col of visibleColumns) {
            const th = document.createElement('th');
            th.textContent = getHeaderLabel(col);
            th.dataset.column = col;
            th.draggable = true;

            if (currentSortColumn === col) {
                th.classList.add(isSortAscending ? 'sort-asc' : 'sort-desc');
            }

            th.addEventListener('click', () => handleSort(col));
            attachHeaderDragHandlers(th, col);
            tableHeadRow.appendChild(th);
        }
    }

    function renderTable() {
        tableBody.replaceChildren();

        if (filteredData.length === 0) {
            showEmptyState('No matching records found.', false);
            paginationContainer.replaceChildren();
            return;
        }

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, filteredData.length);
        const pageData = filteredData.slice(startIndex, endIndex);

        for (const row of pageData) {
            const tr = document.createElement('tr');
            for (const col of visibleColumns) {
                const td = document.createElement('td');
                renderCellContent(td, col, row[col], row);
                tr.appendChild(td);
            }
            tableBody.appendChild(tr);
        }

        renderPagination();
    }

    function renderPagination() {
        const totalPages = Math.ceil(filteredData.length / itemsPerPage);
        paginationContainer.replaceChildren();

        if (totalPages <= 1) {
            return;
        }

        const prevBtn = document.createElement('button');
        prevBtn.className = 'page-btn';
        prevBtn.textContent = 'Previous';
        prevBtn.disabled = currentPage === 1;
        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        });

        const info = document.createElement('span');
        info.className = 'page-info';
        info.textContent = `Page ${currentPage} of ${totalPages} (${filteredData.length} total)`;

        const nextBtn = document.createElement('button');
        nextBtn.className = 'page-btn';
        nextBtn.textContent = 'Next';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.addEventListener('click', () => {
            if (currentPage < totalPages) {
                currentPage++;
                renderTable();
            }
        });

        paginationContainer.append(prevBtn, info, nextBtn);
    }

    function handleSort(col) {
        if (currentSortColumn === col) {
            isSortAscending = !isSortAscending;
        } else {
            currentSortColumn = col;
            isSortAscending = true;
        }

        filteredData.sort((a, b) => {
            let valA = a[col];
            let valB = b[col];

            valA = valA === null || valA === undefined ? '' : valA;
            valB = valB === null || valB === undefined ? '' : valB;

            if (typeof valA === 'string' && typeof valB === 'string') {
                valA = valA.toLowerCase();
                valB = valB.toLowerCase();
            } else if (typeof valA === 'object' || typeof valB === 'object') {
                valA = JSON.stringify(valA);
                valB = JSON.stringify(valB);
            }

            if (valA < valB) {
                return isSortAscending ? -1 : 1;
            }
            if (valA > valB) {
                return isSortAscending ? 1 : -1;
            }
            return 0;
        });

        currentPage = 1;
        renderHeaders();
        renderTable();
    }

    function rowMatchesFilters(row, query, idpVal, tagVal) {
        if (idpVal) {
            if (!row.allowed_idps || !Array.isArray(row.allowed_idps) || !row.allowed_idps.includes(idpVal)) {
                return false;
            }
        }

        if (tagVal) {
            if (!row.tags || !Array.isArray(row.tags) || !row.tags.includes(tagVal)) {
                return false;
            }
        }

        if (!query) {
            return true;
        }

        return columns.some((col) => {
            const val = row[col];
            if (val === null || val === undefined) {
                return false;
            }
            if (typeof val === 'object') {
                return JSON.stringify(val).toLowerCase().includes(query);
            }
            return String(val).toLowerCase().includes(query);
        });
    }

    function handleFilters() {
        const query = searchInput.value.toLowerCase();
        const idpVal = idpFilter.value;
        const tagVal = tagFilter.value;

        filteredData = allData.filter((row) => rowMatchesFilters(row, query, idpVal, tagVal));
        currentPage = 1;
        renderTable();
    }

    function showEmptyState(message, isTotalEmpty = false) {
        tableHeadRow.replaceChildren();

        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = Math.max(visibleColumns.length, 1);
        td.className = 'empty-state';
        td.textContent = message;
        tr.appendChild(td);
        tableBody.replaceChildren(tr);
        paginationContainer.replaceChildren();

        if (isTotalEmpty) {
            searchInput.disabled = true;
            perPageSelect.disabled = true;
            columnToggleBtn.disabled = true;
            idpFilter.disabled = true;
            tagFilter.disabled = true;
        }
    }
});
