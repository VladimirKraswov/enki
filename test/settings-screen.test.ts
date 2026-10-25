// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as requireReact from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_PREFS } from "../src/state/prefs";
const fake = vi.hoisted(() => ({ state: {} as any, setUi: vi.fn(), setAsr: vi.fn(), setHelperEndpoint: vi.fn(), setAppearance: vi.fn(), setTheme: vi.fn(), connect: vi.fn() }));
vi.mock('../src/state/store', () => ({ useAppState: () => fake.state, store: { ...fake, hostLabel: () => "Этот компьютер" } }));
vi.mock('../src/components/CapabilitiesSettings', () => ({ CapabilitiesSettings: ({onDirtyChange}:any) => {const [value,setValue]=requireReact.useState('');return createElement('input',{ 'aria-label':'Общий черновик',value,onChange:(e:any)=>{setValue(e.target.value);onDirtyChange(true);}});}}));
vi.mock('../src/components/ComputerSettings', () => ({ ComputerSettings: () => createElement('p', {}, 'Cua Driver') }));
vi.mock('../src/components/PiSettings', () => ({ PiSettings: ({onDirtyChange}:any) => {const [value,setValue]=requireReact.useState('');return createElement('input',{ 'aria-label':'Черновик Pi',value,onChange:(e:any)=>{setValue(e.target.value);onDirtyChange(true);}});}}));
import { SettingsScreen, searchSettings } from '../src/components/SettingsScreen';
let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLElement.prototype.scrollTo = vi.fn();
  fake.state = { prefs: structuredClone(DEFAULT_PREFS), ui: { settingsOpen: true }, connection: { version: "1.18.18", phase: "connected", streamState: "open" }, connectedProviderIds: ["local"], agents: [] };
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node); act(() => root.render(createElement(SettingsScreen)));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const button = (text: string) => [...document.querySelectorAll('button')].find(e => e.textContent === text)!;
const click = (text: string) => act(() => button(text).click());
function input(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
it("searches actual settings and opens a matching section without altering server configuration", () => {
  expect(searchSettings('размер шрифт').map(x => x.id)).toContain('appearance'); expect(searchSettings('gigaam').map(x => x.id)).toEqual(['voice']); expect(searchSettings('not-a-setting')).toEqual([]);
  input('Поиск настроек', 'шрифт');
  const result = document.querySelector<HTMLButtonElement>('.settings-results button')!; expect(result.textContent).toContain('Внешний вид'); act(() => result.click());
  expect(document.querySelector('h1')?.textContent).toBe('Внешний вид'); expect(document.querySelector('[aria-label="Размер шрифта: Код"]')).not.toBeNull(); expect(fake.connect).not.toHaveBeenCalled(); expect(fake.setAsr).not.toHaveBeenCalled();
});
it("applies appearance independently and validates custom colors", () => {
  click('Внешний вид'); input('Размер шрифта: Сообщения', '20'); expect(fake.setAppearance).toHaveBeenCalledWith({ chatFontSize: 20 });
  input('HEX цвета', '#zzzzzz'); click('Применить цвет'); expect(document.querySelector('[role="alert"]')?.textContent).toContain('шесть');
  input('HEX цвета', '#5599ee'); click('Применить цвет'); expect(fake.setAppearance).toHaveBeenCalledWith({ accent: '#5599ee' });
  click('Сбросить оформление'); expect(fake.setAppearance).toHaveBeenCalledWith(DEFAULT_PREFS.appearance); expect(fake.setTheme).toHaveBeenCalledWith('dark'); expect(fake.setAsr).not.toHaveBeenCalled();
});
it("keeps edited ASR fields across navigation and prevents accidental exit on Escape", () => {
  click('Диктовка'); input('Модель ASR', 'edited-model'); click('Внешний вид'); click('Диктовка'); expect(document.querySelector<HTMLInputElement>('[aria-label="Модель ASR"]')!.value).toBe('edited-model');
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); expect(fake.setUi).not.toHaveBeenCalled(); expect(document.querySelector('[role="alert"]')?.textContent).toContain('несохранённые');
  click('Остаться'); click('Отменить изменения'); click('Вернуться в приложение'); expect(fake.setUi).toHaveBeenCalledWith({ settingsOpen: false }); expect(fake.setAsr).not.toHaveBeenCalled();
});
it("retains staged agent changes across settings sections and guards host navigation", () => {
  click('Агент Enki'); input('Черновик Pi', 'staged'); click('Общее'); click('Управлять…'); expect(fake.setUi).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')).not.toBeNull(); click('Не сохранять и выйти'); expect(fake.setUi).toHaveBeenCalledWith({ settingsOpen: false, hostDialogOpen: true });
});
it("offers the private helper separately from ASR and MCP and validates its loopback address", () => {
  click('Сервисы помощника');
  expect(document.body.textContent).toContain('GigaAM ASR');
  input('Адрес помощника', 'http://192.168.31.54:8080');
  click('Сохранить');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('локальный');
  expect(fake.setHelperEndpoint).not.toHaveBeenCalled();
  input('Адрес помощника', 'http://127.0.0.1:18109');
  click('Сохранить');
  expect(fake.setHelperEndpoint).toHaveBeenCalledWith('http://127.0.0.1:18109');
  expect(fake.setAsr).not.toHaveBeenCalled();
});
it("never offers an external agent install, endpoint or CLI path: the runtime is bundled", () => {
  click('Обзор агента');
  expect(document.body.textContent).toContain('Среда выполнения Enki');
  expect(document.body.textContent).toContain('Архив OpenCode');
  expect([...document.querySelectorAll('button')].some(e => /Установить OpenCode|Настроить OpenCode/.test(e.textContent ?? ''))).toBe(false);
  expect(document.querySelector('[aria-label="Путь к OpenCode CLI"]')).toBeNull();
  expect(document.querySelector('[aria-label="Адрес локального сервера OpenCode"]')).toBeNull();
  expect(fake.connect).not.toHaveBeenCalled();
});

it("keeps shared capability drafts when navigating and warns on exit",()=>{
 click('Навыки и инструменты');input('Общий черновик','unfinished');click('Общее');click('Навыки и инструменты');
 expect(document.querySelector<HTMLInputElement>('[aria-label="Общий черновик"]')!.value).toBe('unfinished');
 click('Вернуться в приложение');expect(fake.setUi).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain('несохранённые');
});

it("shows one executing agent and no OpenCode configuration sections",()=>{
 const nav=document.querySelector('nav[aria-label="Разделы настроек"]')!;
 expect([...nav.querySelectorAll('.settings-nav-label')].map(x=>x.textContent)).toEqual(['Приложение','Общие возможности','Агенты']);
 expect([...nav.querySelectorAll('button')].filter(x=>x.textContent==='Агент Enki')).toHaveLength(1);
 expect([...nav.querySelectorAll('button')].filter(x=>x.textContent==='OpenCode')).toHaveLength(0);
 expect(nav.textContent).not.toContain('Разрешения OpenCode');
 expect(nav.textContent).not.toContain('MCP OpenCode');
 expect(searchSettings('OpenCode плагины').map(x=>x.id)).not.toContain('plugins');
 click('Агент Enki');expect(document.querySelector('nav[aria-label="Разделы настроек"] [aria-current="page"]')?.textContent).toBe('Агент Enki');
});
it("preserves agent drafts across navigation and guards leaving settings",()=>{
 click('Агент Enki');input('Черновик Pi','unfinished pi');click('Общее');click('Агент Enki');
 expect(document.querySelector<HTMLInputElement>('[aria-label="Черновик Pi"]')!.value).toBe('unfinished pi');
 click('Вернуться в приложение');expect(fake.setUi).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain('несохранённые');
});
