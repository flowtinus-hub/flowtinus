import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The worker: a winged sandal (it carries the envelopes). Drawn like a lucide icon so it goes where one goes: in currentColor, sized by className (size-4...), and accepted wherever a LucideIcon is.
 */
export const WorkerIcon = forwardRef<SVGSVGElement, LucideProps>(function WorkerIcon(
    { className, size = 24, color = 'currentColor', strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...props },
    ref,
) {
    return (
        <svg
            ref={ref}
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 192 195"
            fill={color}
            aria-hidden="true"
            className={cn('lucide', className)}
            {...props}
        >
            <g transform="translate(0,195) scale(0.1,-0.1)" stroke={color} strokeWidth={40}>
                <path d="M112 1840 c-50 -31 -65 -78 -60 -180 8 -133 60 -225 152 -270 l43 -20 6 -74 c6 -88 34 -157 83 -207 l34 -35 -30 -55 c-87 -162 -72 -329 41 -453 40 -44 110 -90 377 -249 180 -107 352 -204 382 -214 48 -16 90 -18 331 -18 l276 0 37 29 c21 16 44 44 52 62 35 83 2 200 -75 265 -46 40 -83 53 -191 69 -41 6 -85 13 -98 16 -18 3 -45 51 -136 232 l-114 228 19 25 c66 82 109 213 109 329 0 148 -52 272 -160 381 -71 72 -173 128 -268 148 -33 7 -191 11 -415 11 -345 0 -364 -1 -395 -20z m797 -91 c128 -29 239 -117 298 -237 37 -75 38 -78 38 -192 0 -114 -1 -117 -38 -191 -25 -50 -72 -114 -148 -199 -162 -183 -164 -186 -151 -215 9 -18 19 -25 41 -25 25 0 43 15 113 94 46 52 85 95 88 95 3 1 55 -98 115 -220 61 -121 117 -226 125 -233 8 -8 68 -21 134 -30 71 -9 131 -23 150 -34 46 -27 76 -77 76 -128 0 -74 -7 -76 -302 -72 -248 3 -254 4 -308 29 -30 14 -191 108 -357 208 -330 199 -362 225 -390 320 -21 73 -12 140 31 221 l34 65 118 5 c66 3 125 9 132 13 19 13 15 65 -7 77 -11 5 -62 10 -113 10 -166 1 -236 60 -238 203 l0 47 238 0 c254 0 262 1 262 50 0 49 -6 50 -289 50 -237 0 -270 2 -306 19 -49 22 -73 48 -91 98 -14 39 -19 165 -7 176 11 11 703 8 752 -4z" />
            </g>
        </svg>
    );
}) as LucideIcon;
