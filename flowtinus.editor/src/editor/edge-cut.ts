/*
 * Cut (X held on the canvas): dragging with the primary button cuts every edge the pointer crosses. Each move of the
 * pointer is a segment; an edge is cut when that segment crosses its drawn path (sampled as a polyline).
 */

export type Point = { x: number; y: number };

/** which side of the line a→b point c is: >0 one side, <0 the other, 0 on it */
const side = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** whether the segments a→b and c→d cross or touch */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
    const d1 = side(c, d, a);
    const d2 = side(c, d, b);
    const d3 = side(a, b, c);
    const d4 = side(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }

    // touching: an end of one on the other
    const within = (p: Point, q: Point, r: Point) =>
        Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
    return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/** whether the segment from→to crosses the polyline */
export function crossesPolyline(from: Point, to: Point, polyline: Point[]): boolean {
    for (let i = 1; i < polyline.length; i++) {
        if (segmentsCross(from, to, polyline[i - 1]!, polyline[i]!)) {
            return true;
        }
    }

    return false;
}

/** the ids of the edges whose polyline (pointsOf) the segment from→to crosses */
export function crossedEdges(from: Point, to: Point, edgeIds: string[], pointsOf: (id: string) => Point[]): string[] {
    return edgeIds.filter(id => crossesPolyline(from, to, pointsOf(id)));
}
