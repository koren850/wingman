export type IcsPerson = { name: string; email: string; role: string; status: string };
export type IcsEvent = {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  attendees: IcsPerson[];
  organizer: IcsPerson | null;
  location: string;
  description: string;
  recurring: boolean;
  cancelled: boolean;
};
declare const m: {
  parseIcs(text: string): { events: IcsEvent[] };
  pickEvent(events: IcsEvent[], now: number): IcsEvent | null;
  eventToPlan(ev: IcsEvent): { fields: { title: string; at: number; who: string }; text: string };
};
export = m;
