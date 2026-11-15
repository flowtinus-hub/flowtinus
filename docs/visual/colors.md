# Colors

Flowtinus's palette: the brand color and the editor's theme tokens (`flowtinus.editor/src/index.css`, shadcn style). The CSS values are the source of truth; the hex values below are approximate (converted from OKLCH, for reference).

## Brand

| Name               | Hex       | OKLCH                   | Use                                                                                       |
| ------------------ | --------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| **Flowtinus Gold** | `#F2A93B` | `oklch(0.787 0.147 73)` | The primary color, in both themes. Primary actions, active states, focus and brand marks. |
| Brand background   | `#111111` | `oklch(0.178 0 0)`      | The dark background of the brand assets (favicon, icons) and the text on the gold.        |

The gold is the same in the light and dark themes: `--primary`, `--ring`, `--sidebar-primary` and `--sidebar-ring`. Text on it is dark (`--primary-foreground` and `--sidebar-primary-foreground` = `#111111`), at about 9:1 contrast.

### Using the gold

- **Do** use it as a fill: primary buttons, active tabs and items, focus rings, selection and running indicators, the brand.
- **Do** always put dark text on it (`text-primary-foreground`), never white.
- **Avoid** the gold as text (`text-primary`) on a light background: its contrast with white is about 2:1, unreadable as body text. In the dark theme, gold text works.
- For text and links in the light theme, prefer `text-foreground` with an underline, or the gold as a background.

## Flow nodes

The Start and End cards on the canvas (`--node-fixed`, `--node-fixed-foreground`) belong to the gold family without being the gold itself, so the flow's ends stand out from its components and don't read as primary buttons.

| Theme | Fill                                             | Name and icon                       |
| ----- | ------------------------------------------------ | ----------------------------------- |
| Light | Honey gold `oklch(0.9 0.085 82)` (`#FAD99D`)     | Dark `oklch(0.178 0 0)` (`#111111`) |
| Dark  | Pale sand gold `oklch(0.88 0.07 85)` (`#EDD5A3`) | Dark `oklch(0.178 0 0)` (`#111111`) |

Both are lighter than Flowtinus Gold, with dark text on them, so they read as the brand's family but not as primary buttons.

## Light theme (`:root`)

| Token                          | CSS value                   | Approx. hex |
| ------------------------------ | --------------------------- | ----------- |
| `--background`                 | `#f5f5f5`                   | `#F5F5F5`   |
| `--foreground`                 | `oklch(0.145 0 0)`          | `#0A0A0A`   |
| `--card`                       | `oklch(1 0 0)`              | `#FFFFFF`   |
| `--card-foreground`            | `oklch(0.145 0 0)`          | `#0A0A0A`   |
| `--popover`                    | `oklch(1 0 0)`              | `#FFFFFF`   |
| `--popover-foreground`         | `oklch(0.145 0 0)`          | `#0A0A0A`   |
| `--primary`                    | `oklch(0.787 0.147 73)`     | `#F2A93B`   |
| `--primary-foreground`         | `oklch(0.178 0 0)`          | `#111111`   |
| `--secondary`                  | `oklch(0.97 0 0)`           | `#F5F5F5`   |
| `--secondary-foreground`       | `oklch(0.205 0 0)`          | `#171717`   |
| `--muted`                      | `oklch(0.97 0 0)`           | `#F5F5F5`   |
| `--muted-foreground`           | `oklch(0.556 0 0)`          | `#737373`   |
| `--accent`                     | `oklch(0.97 0 0)`           | `#F5F5F5`   |
| `--accent-foreground`          | `oklch(0.205 0 0)`          | `#171717`   |
| `--destructive`                | `oklch(0.577 0.245 27.325)` | `#E7000B`   |
| `--border`                     | `oklch(0.922 0 0)`          | `#E5E5E5`   |
| `--input`                      | `oklch(0.922 0 0)`          | `#E5E5E5`   |
| `--ring`                       | `oklch(0.787 0.147 73)`     | `#F2A93B`   |
| `--canvas`                     | `oklch(0.937 0 0)`          | `#EAEAEA`   |
| `--grid`                       | `oklch(0.8 0.008 250)`      | `#BABEC3`   |
| `--node-fixed`                 | `oklch(0.9 0.085 82)`       | `#FAD99D`   |
| `--node-fixed-foreground`      | `oklch(0.178 0 0)`          | `#111111`   |
| `--category-database`          | `oklch(0.68 0.15 65)`       | `#D6810C`   |
| `--category-api`               | `oklch(0.58 0.12 165)`      | `#0A9068`   |
| `--category-code`              | `oklch(0.55 0.18 300)`      | `#8451C9`   |
| `--category-transformation`    | `oklch(0.55 0.15 235)`      | `#007CBB`   |
| `--category-flow`              | `oklch(0.42 0.02 250)`      | `#454E58`   |
| `--sidebar`                    | `oklch(0.985 0 0)`          | `#FAFAFA`   |
| `--sidebar-foreground`         | `oklch(0.145 0 0)`          | `#0A0A0A`   |
| `--sidebar-primary`            | `oklch(0.787 0.147 73)`     | `#F2A93B`   |
| `--sidebar-primary-foreground` | `oklch(0.178 0 0)`          | `#111111`   |

## Dark theme (`.dark`)

| Token                          | CSS value                   | Approx. hex      |
| ------------------------------ | --------------------------- | ---------------- |
| `--background`                 | `oklch(0.145 0 0)`          | `#0A0A0A`        |
| `--foreground`                 | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--card`                       | `oklch(0.205 0 0)`          | `#171717`        |
| `--card-foreground`            | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--popover`                    | `oklch(0.205 0 0)`          | `#171717`        |
| `--popover-foreground`         | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--primary`                    | `oklch(0.787 0.147 73)`     | `#F2A93B`        |
| `--primary-foreground`         | `oklch(0.178 0 0)`          | `#111111`        |
| `--secondary`                  | `oklch(0.269 0 0)`          | `#262626`        |
| `--secondary-foreground`       | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--muted`                      | `oklch(0.269 0 0)`          | `#262626`        |
| `--muted-foreground`           | `oklch(0.708 0 0)`          | `#A1A1A1`        |
| `--accent`                     | `oklch(0.269 0 0)`          | `#262626`        |
| `--accent-foreground`          | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--destructive`                | `oklch(0.704 0.191 22.216)` | `#FF6467`        |
| `--border`                     | `oklch(1 0 0 / 10%)`        | `#FFFFFF at 10%` |
| `--input`                      | `oklch(1 0 0 / 15%)`        | `#FFFFFF at 15%` |
| `--ring`                       | `oklch(0.787 0.147 73)`     | `#F2A93B`        |
| `--canvas`                     | `oklch(0.27 0.01 250)`      | `#23272B`        |
| `--grid`                       | `oklch(0.4 0.012 250)`      | `#43484E`        |
| `--node-fixed`                 | `oklch(0.88 0.07 85)`       | `#EDD5A3`        |
| `--node-fixed-foreground`      | `oklch(0.178 0 0)`          | `#111111`        |
| `--category-database`          | `oklch(0.8 0.14 75)`        | `#F2AF48`        |
| `--category-api`               | `oklch(0.76 0.12 165)`      | `#5BC99E`        |
| `--category-code`              | `oklch(0.74 0.15 300)`      | `#BA93FB`        |
| `--category-transformation`    | `oklch(0.74 0.13 228)`      | `#36BAEB`        |
| `--category-flow`              | `oklch(0.88 0.01 250)`      | `#D3D8DE`        |
| `--sidebar`                    | `oklch(0.205 0 0)`          | `#171717`        |
| `--sidebar-foreground`         | `oklch(0.985 0 0)`          | `#FAFAFA`        |
| `--sidebar-primary`            | `oklch(0.787 0.147 73)`     | `#F2A93B`        |
| `--sidebar-primary-foreground` | `oklch(0.178 0 0)`          | `#111111`        |

The `--chart-*` tokens (grays) and `--radius` are left out: they are not identity colors.
