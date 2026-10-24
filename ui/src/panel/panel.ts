import type { Actions } from '../actions';
import type { OfficeApi } from '../api';
import { el } from '../dom';
import type { Store } from '../store';
import { mountDeliverables } from './deliverables';
import { mountFloors, type FloorLinks } from './floors';
import { mountHeader } from './header';
import { mountMemory } from './memory';
import { mountNotes } from './notes';
import { mountNow } from './now';
import { mountOrders } from './orders';
import { mountQuestion } from './question-form';
import { mountReport } from './report';
import { mountTimeline } from './timeline';

export function mountPanel(host: HTMLElement, store: Store, actions: Actions, api: OfficeApi | null, links: FloorLinks): void {
  const header = el('div', 'panel-header');
  const notes = el('div', 'panel-notes');
  const floors = el('div', 'panel-floors');
  const now = el('div', 'panel-now');
  const question = el('div', 'panel-question');
  const deliverables = el('div', 'panel-deliverables');
  const report = el('div', 'panel-report');
  const memory = el('div', 'panel-memory');
  const timeline = el('div', 'panel-timeline');
  const orders = el('div', 'panel-orders');

  host.replaceChildren(header, el('div', 'panel-scroll', notes, floors, now, question, deliverables, report, memory, timeline), orders);

  mountHeader(header, store);
  mountNotes(notes, store);
  mountFloors(floors, store, api, links);
  mountNow(now, store, api);
  mountQuestion(question, store, actions);
  mountDeliverables(deliverables, store, api);
  mountReport(report, store, api);
  mountMemory(memory, store, api);
  mountTimeline(timeline, store, api);
  mountOrders(orders, store, actions);
}
