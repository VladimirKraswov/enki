# Иконка Enki

Канонический растровый исходник — [src/assets/enki-icon-master.png](../src/assets/enki-icon-master.png).
Знак — объёмная непрерывная лента в форме строчной «e» со светлой искрой в центре.
Тёплые медные и янтарные оттенки сочетаются с мягкими золотистыми бликами
и тёмной скруглённой плиткой. Крупный силуэт рассчитан на ярлык приложения;
мелкие декоративные детали отсутствуют.

Рисунок создан встроенным imagegen, затем тем же инструментом изменена только
палитра. Прозрачность снаружи плитки сохранена. Боковая панель и favicon
используют 256px копию `src/assets/enki-icon.png`; нативные PNG, Windows ICO/Appx
и macOS ICNS получены из того же мастера штатным Tauri CLI.

## Воспроизведение упаковки

```sh
npm run tauri -- icon src/assets/enki-icon-master.png --output .local/enki-icons
cp .local/enki-icons/128x128@2x.png src/assets/enki-icon.png
```

Скопируйте только соответствующие существующим настольные файлы из `.local/enki-icons`
в `src-tauri/icons`. Мобильные ресурсы в проект не включаются.
Не заменяйте мастер уменьшенным `icon.png`: исходник нужен для следующих сборок.
Иконка трея использует нативный ресурс приложения. Новая иконка Dock/меню
запуска требует нативного обновления; горячая UI-замена обновляет только интерфейс.

## Промпт исходной генерации

Use case: logo-brand. Create ONE finished premium desktop application icon for Enki, a modern AI coding assistant. A completely fresh identity. Asset: a crisp square 1024x1024 app icon, straight-on orthographic, not a presentation sheet or a mockup. Design a bold sculptural abstract 'e' emblem from one continuous folded luminous ribbon, with a small intelligent spark implied by the central negative space. Make the silhouette simple, memorable, confident and clearly readable at 24px. Refined glass/ceramic material with restrained dimensional depth, rich electric blue flowing into a subtle violet highlight, clean bright edges and generous negative space. Center the emblem on a satin midnight-indigo rounded-square app tile with very soft depth, tile occupying about 88% of the canvas and optically balanced. Subtle premium studio light, no busy glow, no fine ornament. Genuinely transparent pixels outside the rounded-square tile. No words, no captions, no robot, no face, no brain, no circuit-board pattern, no existing company logo, no watermark. Deliver only the beautifully polished app icon.

## Промпт тёплой палитры

Use case: precise-object-edit, palette-only edit of the provided Enki app icon. Preserve the exact stylized folded-ribbon e, central spark negative space, proportions, front-facing perspective, rounded-square tile shape, lighting quality, polished glass/ceramic finish and genuinely transparent outside pixels. Change the cool blue/cyan/violet palette to a beautiful cohesive WARM premium palette: luminous burnished copper and amber ribbon, subtle terracotta/orange midtones, soft pale champagne-gold highlights, warm ivory spark. Change the tile from cold indigo to a refined very dark warm charcoal/espresso. Keep strong contrast and a simple readable silhouette at small desktop icon sizes; make it elegant and contemporary, not fiery or gaudy. No new symbols, no text, no extra objects, no watermark. Deliver only the finished warm app icon.
