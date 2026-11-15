import { END, START } from '#engine/constants';

/*
 * The size of a card on the canvas and where its ports are, in canvas px (the grid step is 16): the editor draws and
 * lays out its cards with these, and the validator warns when one is drawn over another.
 */

/** every card has this size, in grid steps (5 × 10); the first port is at the middle of its height */
export const CARD_HEIGHT = 80;
export const CARD_WIDTH = 160;
/** the Start and the End (arrows) are a bit narrower: still whole grid steps (8), so what comes after them stays on the grid */
export const ARROW_CARD_WIDTH = 128;
/** the card is drawn this much narrower than its grid width: cards snapped side by side keep this gap (the bump sits in the next one's hole) */
export const SIDE_GAP = 6;
/** a gap between cards stacked one under another: one grid step, so snapped cards line up (80 + 16 = 96) */
export const STACK_GAP = 16;
/** between one port and the next, downwards: a card's height and the gap, so each port lines up with a card below */
export const PORT_GAP = CARD_HEIGHT + STACK_GAP;

/** the port's height from the top of the card */
export const portTop = (i: number) => CARD_HEIGHT / 2 + i * PORT_GAP;

/** a card's grid width by its component type */
export const cardWidth = (type: string) => (type === START || type === END ? ARROW_CARD_WIDTH : CARD_WIDTH);
