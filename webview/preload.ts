// Restores images of games that are delisted from Steam or region-locked: finds the AppID and loads the image
// from the Steam CDN. Same logic as the Chrome extension (../../steam_delisted_fix/content.js).
// Возвращает картинки игр, удалённых из Steam или закрытых в регионе: находит AppID и подставляет картинку
// с CDN Steam. Та же логика, что в расширении Chrome (../../steam_delisted_fix/content.js).

const FIXED_FLAG = 'delistedFix';
const HIDDEN_FLAG = 'delistedHidden';

// Steam community profile pages (the plugin runs on all Steam web pages).
// Страницы профилей сообщества Steam (плагин запускается на всех веб-страницах Steam).
const PROFILE_PAGE_PATTERN = /^\/(?:id|profiles)\//;

// Steam CDN base; the path without a hash works for any game.
// Адрес CDN Steam; путь без хэша работает для любой игры.
const CDN_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

// Image file per block, used when the block has no other image to copy the format from.
// Файл картинки для блока, если в блоке нет другой картинки, с которой можно взять формат.
const CONTAINER_FILES: [string, string][] = [
    ['.showcase_achievementscompletionist_game', 'header.jpg'],
    ['.showcase_gamecollector_game', 'capsule_184x69.jpg'],
    ['.favorite_game_cap', 'capsule_184x69.jpg'],
    ['.game_info_cap', 'capsule_184x69.jpg'],
];

// How many levels up to look for neighbour images.
// На сколько уровней вверх искать соседние картинки.
const SIBLING_SEARCH_DEPTH = 6;

// Game library: card image and the grey placeholder Steam shows for unavailable games.
// Библиотека игр: картинка карточки и серая заглушка Steam для недоступных игр.
const LIBRARY_IMG_SELECTOR = 'a[href*="/app/"] picture > img';
const LIBRARY_FILE = 'header.jpg';
const STEAM_PLACEHOLDER_PREFIX = 'data:image/png';

// Game achievements page: cover block (found by its grid area) and blurred background block.
// Страница достижений игры: блок обложки (по области сетки) и блок размытого фона.
const ACHIEVEMENTS_PAGE_PATTERN = /^\/(?:id|profiles)\/[^/]+\/achievements\/(\d+)/;
const CAPSULE_SELECTOR = '[style*="--grid-area:capsule"], [style*="--grid-area: capsule"]';
const CAPSULE_CONTENT_SELECTOR = 'img, [style*="background-image"], a[href*="/app/"]:not([href*="/app/0/"])';
const ACHIEVEMENTS_FILE = 'library_600x900.jpg';
const HERO_SELECTOR = '[style*="translateX(-50%)"]';
const HERO_FILE = 'library_hero.jpg';

// Blurred background behind the achievements page header (same as content.css of the extension).
// Размытый фон за шапкой страницы достижений (то же, что content.css расширения).
const HERO_CSS = `
[data-delisted-hero]::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    margin: 0 auto;
    z-index: -1;
    height: min(80vh, 600px);
    width: min(100%, calc(min(80vh, 600px) * 1920 / 620));
    background: var(--delisted-hero) center / cover no-repeat;
    filter: blur(30px) opacity(0.21);
    -webkit-mask-image: linear-gradient(#000 78%, #0000 96%);
    mask-image: linear-gradient(#000 78%, #0000 96%);
}`;

interface BlockState {
    appId: string;
    status: 'normal' | 'checking' | 'missing' | 'found';
    url?: string;
}

interface OriginalSrc {
    src: string | null;
    sources: [HTMLSourceElement, string | null][];
}

// Hidden cover blocks: block -> its original style.display.
// Спрятанные блоки обложки: блок -> исходный style.display.
const hiddenCapsules = new WeakMap<HTMLElement, string>();
// Check results for cover and background blocks.
// Результаты проверки блоков обложки и фона.
const capsuleState = new WeakMap<HTMLElement, BlockState>();
const heroState = new WeakMap<HTMLElement, BlockState>();
// CDN check results: url -> Promise<boolean>.
// Результаты проверки на CDN: url -> Promise<boolean>.
const probeCache = new Map<string, Promise<boolean>>();

// The src we set, and what Steam had before us.
// src, который поставили мы, и то, что было у Steam до нас.
const ownSrc = new WeakMap<HTMLImageElement, string | null>();
const originalSrc = new WeakMap<HTMLImageElement, OriginalSrc>();
// Hidden placeholder labels: label -> its original style.display.
// Спрятанные подписи заглушки: подпись -> исходный style.display.
const hiddenLabels = new WeakMap<HTMLElement, string>();

// AppID from the link around the image.
// AppID из ссылки вокруг картинки.
function getAppId(img: Element): string | null {
    const link = img.closest<HTMLAnchorElement>('a[href]');
    const match = link?.href.match(/\/(?:app|apps|achievements|stats)\/(\d+)/);
    return match ? match[1] : null;
}

// File name from a Steam image URL: .../apps/{appid}/[{hash}/]{file}.
// Имя файла из адреса картинки Steam: .../apps/{appid}/[{хэш}/]{файл}.
function getFileName(src: string): string | null {
    try {
        const match = new URL(src).pathname.match(/\/apps\/\d+\/(?:[0-9a-f]{16,}\/)?([^/]+\.(?:jpg|png))$/i);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

// Image file: from the nearest normal image in the block, otherwise by block class, otherwise null.
// Файл картинки: с ближайшей нормальной картинки блока, иначе по классу блока, иначе null.
function findFileName(img: HTMLImageElement): string | null {
    let node = img.parentElement;
    for (let depth = 0; node && depth < SIBLING_SEARCH_DEPTH; depth++, node = node.parentElement) {
        for (const sibling of node.querySelectorAll<HTMLImageElement>('img.game_capsule')) {
            if (sibling === img || sibling.dataset[FIXED_FLAG]) continue;
            const file = getFileName(sibling.getAttribute('src') || '');
            if (file) return file;
        }
    }

    for (const [selector, file] of CONTAINER_FILES) {
        if (img.closest(selector)) return file;
    }
    return null;
}

// <source> elements of the parent <picture>.
// Элементы <source> родительского <picture>.
function getSources(img: HTMLImageElement): HTMLSourceElement[] {
    const parent = img.parentElement;
    return parent?.tagName === 'PICTURE' ? [...parent.querySelectorAll('source')] : [];
}

// Sets the image URL (also in <source>) and remembers the original.
// Ставит адрес картинки (и в <source>) и запоминает исходный.
function setSrc(img: HTMLImageElement, url: string): void {
    if (!originalSrc.has(img)) {
        originalSrc.set(img, {
            src: img.getAttribute('src'),
            sources: getSources(img).map((source) => [source, source.getAttribute('srcset')]),
        });
    }
    getSources(img).forEach((source) => {
        source.srcset = url;
    });
    img.src = url;
    ownSrc.set(img, img.getAttribute('src'));
}

// Puts back what Steam had.
// Возвращает то, что было у Steam.
function restoreSrc(img: HTMLImageElement): void {
    const original = originalSrc.get(img);
    if (!original) return;
    for (const [source, srcset] of original.sources) {
        if (srcset === null) source.removeAttribute('srcset');
        else source.setAttribute('srcset', srcset);
    }
    if (original.src === null) img.removeAttribute('src');
    else img.setAttribute('src', original.src);
    ownSrc.delete(img);
    originalSrc.delete(img);
    showPlaceholderLabel(img);
}

// Game name label Steam puts over its placeholder: the <span> right after <picture>.
// Подпись с названием игры, которую Steam кладёт поверх заглушки: <span> сразу после <picture>.
function getPlaceholderLabel(img: HTMLImageElement): HTMLElement | null {
    const picture = img.parentElement;
    if (picture?.tagName !== 'PICTURE') return null;
    const label = picture.nextElementSibling;
    return label instanceof HTMLElement && label.tagName === 'SPAN' ? label : null;
}

// Hides the placeholder label.
// Прячет подпись заглушки.
function hidePlaceholderLabel(img: HTMLImageElement): void {
    const label = getPlaceholderLabel(img);
    if (!label || hiddenLabels.has(label)) return;
    hiddenLabels.set(label, label.style.display);
    label.style.display = 'none';
}

// Shows the placeholder label back.
// Показывает подпись заглушки обратно.
function showPlaceholderLabel(img: HTMLImageElement): void {
    const label = getPlaceholderLabel(img);
    if (!label || !hiddenLabels.has(label)) return;
    label.style.display = hiddenLabels.get(label) ?? '';
    hiddenLabels.delete(label);
}

// The image still has our src.
// У картинки всё ещё наш src.
function isOwnSrc(img: HTMLImageElement): boolean {
    return ownSrc.has(img) && ownSrc.get(img) === img.getAttribute('src');
}

// Loads the image from the CDN.
// Подставляет картинку с CDN.
function loadImage(img: HTMLImageElement, appId: string, file: string): void {
    setSrc(img, `${CDN_BASE}/${appId}/${file}`);
}

// Our image failed to load: hide the error from Steam's handlers and put back what Steam had.
// Наша картинка не загрузилась: скрываем ошибку от обработчиков Steam и возвращаем как было.
function onImageError(event: Event): void {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !isOwnSrc(img)) return;
    event.stopImmediatePropagation();
    restoreSrc(img);
}

function isEmptySrc(img: HTMLImageElement): boolean {
    const src = img.getAttribute('src');
    return !src || src.trim() === '';
}

// Profile showcases and recent activity: <img class="game_capsule" src="">.
// Витрины профиля и «Недавняя активность»: <img class="game_capsule" src="">.
function fixCapsule(element: Element): void {
    if (!(element instanceof HTMLImageElement)) return;
    const img = element;
    if (img.dataset[FIXED_FLAG] || !isEmptySrc(img)) return;

    const appId = getAppId(img);
    if (!appId) return;

    const file = findFileName(img);
    if (!file) return;

    img.dataset[FIXED_FLAG] = '1';
    loadImage(img, appId, file);
}

// Game library: replaces Steam's placeholder; the flag stores the AppID because cards are reused on scroll.
// Библиотека игр: заменяет заглушку Steam; во флаге AppID, потому что карточки переиспользуются при прокрутке.
function fixLibraryImage(element: Element): void {
    if (!(element instanceof HTMLImageElement)) return;
    const img = element;
    const appId = getAppId(img);
    if (!appId) return;

    const fixedFor = img.dataset[FIXED_FLAG];
    if (fixedFor === appId) return;

    const src = img.getAttribute('src') || '';
    if (!src.startsWith(STEAM_PLACEHOLDER_PREFIX) && !(fixedFor && isOwnSrc(img))) {
        if (fixedFor) delete img.dataset[FIXED_FLAG];
        return;
    }

    img.dataset[FIXED_FLAG] = appId;
    hidePlaceholderLabel(img);
    loadImage(img, appId, LIBRARY_FILE);
}

// Checks whether the URL loads, using an image outside the DOM.
// Проверяет, загружается ли адрес, через картинку вне DOM.
function probeImage(url: string): Promise<boolean> {
    let result = probeCache.get(url);
    if (!result) {
        result = new Promise<boolean>((resolve) => {
            const probe = new Image();
            probe.onload = () => resolve(true);
            probe.onerror = () => resolve(false);
            probe.src = url;
        });
        probeCache.set(url, result);
    }
    return result;
}

// Hides the cover block.
// Прячет блок обложки.
function hideCapsule(capsule: HTMLElement): void {
    hiddenCapsules.set(capsule, capsule.style.display);
    capsule.dataset[HIDDEN_FLAG] = '1';
    capsule.style.display = 'none';
}

// Shows the cover block back.
// Показывает блок обложки обратно.
function showCapsule(capsule: HTMLElement): void {
    if (!hiddenCapsules.has(capsule)) return;
    capsule.style.display = hiddenCapsules.get(capsule) ?? '';
    hiddenCapsules.delete(capsule);
    delete capsule.dataset[HIDDEN_FLAG];
}

// The element is fully parsed: it has a next sibling or parsing is over.
// Элемент разобран целиком: у него есть следующий сосед или разбор закончен.
function isElementComplete(element: Element): boolean {
    return element.nextElementSibling !== null || document.readyState !== 'loading';
}

function getAchievementsAppId(): string | null {
    return window.location.pathname.match(ACHIEVEMENTS_PAGE_PATTERN)?.[1] ?? null;
}

// Achievements page cover: hides the empty block and shows it with library_600x900.jpg if the file exists.
// Обложка на странице достижений: прячет пустой блок и показывает с library_600x900.jpg, если файл есть.
async function fixAchievementsCapsule(element: Element): Promise<void> {
    if (!(element instanceof HTMLElement)) return;
    const capsule = element;
    const appId = getAchievementsAppId();
    if (!appId) return;

    const known = capsuleState.get(capsule);
    if (known?.appId === appId) {
        if (known.status === 'found' && known.url) applyCover(capsule, known.url);
        return;
    }

    if (!isElementComplete(capsule)) return;
    if (capsule.querySelector(CAPSULE_CONTENT_SELECTOR)) {
        capsuleState.set(capsule, { appId, status: 'normal' });
        return;
    }

    const url = `${CDN_BASE}/${appId}/${ACHIEVEMENTS_FILE}`;
    const state: BlockState = { appId, status: 'checking', url };
    capsuleState.set(capsule, state);
    capsule.dataset[FIXED_FLAG] = appId;
    if (!hiddenCapsules.has(capsule)) hideCapsule(capsule);

    const found = await probeImage(url);
    const sameGame = capsuleState.get(capsule) === state;
    if (!found || !sameGame || !capsule.isConnected) {
        if (sameGame) state.status = 'missing';
        return;
    }

    state.status = 'found';
    if (applyCover(capsule, url)) showCapsule(capsule);
}

// Sets the cover as the background of the empty div; padding-top 150% gives the 2:3 frame.
// Ставит обложку фоном пустому div; padding-top 150% даёт рамку 2:3.
function applyCover(capsule: HTMLElement, url: string): boolean {
    const box = capsule.querySelector<HTMLElement>('div:empty');
    if (!box) return false;
    if (box.style.backgroundImage.includes(url)) return true;

    Object.assign(box.style, {
        backgroundImage: `url("${url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        paddingTop: '150%',
    });
    return true;
}

// Background block: the first child of the wrapper with isolation:isolate.
// Блок фона: первый ребёнок обёртки с isolation:isolate.
function isHeroBlock(element: Element): boolean {
    const parent = element.parentElement;
    return parent?.firstElementChild === element && /isolation:\s*isolate/.test(parent.getAttribute('style') || '');
}

// Achievements page background: adds library_hero.jpg to the empty block if the file exists.
// Фон на странице достижений: ставит library_hero.jpg в пустой блок, если файл есть.
async function fixAchievementsHero(element: Element): Promise<void> {
    if (!(element instanceof HTMLElement)) return;
    const hero = element;
    const appId = getAchievementsAppId();
    if (!appId || !isHeroBlock(hero)) return;

    const known = heroState.get(hero);
    if (known?.appId === appId) {
        if (known.status === 'found' && known.url) applyHero(hero, known.url);
        return;
    }

    if (!isElementComplete(hero)) return;
    if (hero.children.length) {
        heroState.set(hero, { appId, status: 'normal' });
        return;
    }

    const url = `${CDN_BASE}/${appId}/${HERO_FILE}`;
    const state: BlockState = { appId, status: 'checking', url };
    heroState.set(hero, state);

    const found = await probeImage(url);
    const sameGame = heroState.get(hero) === state;
    if (!found || !sameGame || !hero.isConnected) {
        if (sameGame) state.status = 'missing';
        return;
    }

    state.status = 'found';
    applyHero(hero, url);
}

// Marks the block for HERO_CSS and passes the image URL.
// Помечает блок для HERO_CSS и передаёт адрес картинки.
function applyHero(hero: HTMLElement, url: string): void {
    const value = `url("${url}")`;
    if (hero.dataset.delistedHero && hero.style.getPropertyValue('--delisted-hero') === value) return;
    hero.dataset.delistedHero = '1';
    hero.style.setProperty('--delisted-hero', value);
}

// Shows a hidden cover block again if an available game appeared in it.
// Показывает спрятанный блок обложки, если в нём появилась доступная игра.
function showIfNotDelisted(node: Node): void {
    if (!(node instanceof Element)) return;
    const capsule = node.closest<HTMLElement>('[data-delisted-hidden]');
    if (capsule && capsule.querySelector('img, a[href*="/app/"]:not([href*="/app/0/"])')) {
        showCapsule(capsule);
        capsuleState.delete(capsule);
        delete capsule.dataset[FIXED_FLAG];
    }
}

// What to look for and how to fix it.
// Что ищем и чем чиним.
const HANDLERS: [string, (element: Element) => void][] = [
    ['img.game_capsule', fixCapsule],
    [LIBRARY_IMG_SELECTOR, fixLibraryImage],
    [CAPSULE_SELECTOR, (element) => void fixAchievementsCapsule(element)],
    [HERO_SELECTOR, (element) => void fixAchievementsHero(element)],
];

// Checks the previous sibling: the parser has finished it.
// Проверяет предыдущего соседа: парсер его уже закончил.
function checkPreviousBlock(node: Element): void {
    const previous = node.previousElementSibling;
    if (previous?.matches(CAPSULE_SELECTOR)) void fixAchievementsCapsule(previous);
    if (previous?.matches(HERO_SELECTOR)) void fixAchievementsHero(previous);
}

// Fixes the node and its descendants.
// Чинит узел и его потомков.
function fixNode(node: Node): void {
    if (!(node instanceof Element)) return;
    for (const [selector, fix] of HANDLERS) {
        if (node.matches(selector)) fix(node);
        node.querySelectorAll(selector).forEach((element) => fix(element));
    }
}

// Handles DOM changes before the frame is painted.
// Обрабатывает изменения DOM до отрисовки кадра.
function onMutations(records: MutationRecord[]): void {
    for (const record of records) {
        if (record.type === 'childList') {
            record.addedNodes.forEach((node) => {
                fixNode(node);
                if (node instanceof Element) checkPreviousBlock(node);
            });
            showIfNotDelisted(record.target);
            const capsule =
                record.target instanceof Element ? record.target.closest<HTMLElement>(CAPSULE_SELECTOR) : null;
            if (capsule && capsuleState.has(capsule)) void fixAchievementsCapsule(capsule);
        } else {
            fixNode(record.target);
            showIfNotDelisted(record.target);
        }
    }
}

// Adds the background CSS to the page.
// Добавляет на страницу CSS для фона.
function injectStyles(): void {
    const style = document.createElement('style');
    style.id = 'delisted-fix-styles';
    style.textContent = HERO_CSS;
    (document.head || document.documentElement).appendChild(style);
}

function start(): void {
    injectStyles();

    // Catches image errors before the page handlers.
    // Ловит ошибки картинок раньше обработчиков страницы.
    window.addEventListener('error', onImageError, true);

    // Watches the whole document.
    // Следит за всем документом.
    new MutationObserver(onMutations).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'href', 'alt'],
    });

    // One full pass after parsing (or right away if the page is already parsed).
    // Один полный проход после разбора страницы (или сразу, если она уже разобрана).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => fixNode(document.documentElement), { once: true });
    } else {
        fixNode(document.documentElement);
    }
}

export default async function WebkitMain() {
    if (window.location.hostname !== 'steamcommunity.com' || !PROFILE_PAGE_PATTERN.test(window.location.pathname)) {
        return;
    }
    start();
}
