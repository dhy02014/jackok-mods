// Every string the person reads. English whatever Claude Code's `language` setting says;
// only a card's own text follows that setting (toolsFor in ./cards). What the model reads
// (tool specs and results) is English too.

export const t = {
  commandDescription: 'Show or hide the handoff band; open|hold|all sets its filter',
  unknownFilter: (arg: string) => `Unknown filter "${arg}": use open, hold or all.`,
  bandFilter: (f: string) => `Handoff band shows ${f === 'all' ? 'every card' : `${f} cards`}.`,
  bandHidden: 'Handoff band hidden.',
  bandShown: 'Handoff band shown.',
  copied: (path: string) => `Card path copied: ${path}`,
  copyFailed: (reason: string) => `Could not copy the card path (${reason})`,
  // The hold on /clear or /exit.
  leftover: (dirty: number, command: string) =>
    `${dirty} uncommitted ${dirty === 1 ? 'change is' : 'changes are'} left. If the work goes on later, ask Claude to write a handoff card. To go ahead anyway, enter ${command} again.`,
  // The band's header, its row when nothing matches, and each card's age.
  title: 'handoff',
  noCards: 'No cards.',
  noFilterCards: (f: string) => `No ${f} cards.`,
  age: (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`,
  // What the card and list rows' result blocks say after a card's title.
  rowCreated: '(new)',
  rowUpdated: '(updated)',
  rowClosed: '(closed)',
  rowUnreadable: '(unreadable)',
}

export type Strings = typeof t
