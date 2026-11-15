import { describe, expect, test } from 'bun:test';
import { AppSettingsError, readAppSettings } from '#shared/config/app-settings';

describe('WORKER_COLOR', () => {
    const color = (value?: string) => readAppSettings({ WORKER_COLOR: value }).workerColor;

    test('a name, #rrggbb or #rgb, always as #rrggbb; empty = none', () => {
        expect(color('violet')).toBe('#8b5cf6');
        expect(color(' Sky ')).toBe('#0ea5e9');
        expect(color('#AABBCC')).toBe('#aabbcc');
        expect(color('f0a')).toBe('#ff00aa');
        expect(color('')).toBeUndefined();
        expect(color()).toBeUndefined();
    });

    test('anything else is refused, naming the variable', () => {
        expect(() => color('banana')).toThrow(AppSettingsError);
        expect(() => color('#12345')).toThrow('WORKER_COLOR');
    });
});

describe('FIRE_AND_FORGET_PER_WORKER', () => {
    test('4 by default; at least 1', () => {
        expect(readAppSettings({}).fireAndForgetPerWorker).toBe(4);
        expect(readAppSettings({ FIRE_AND_FORGET_PER_WORKER: '10' }).fireAndForgetPerWorker).toBe(10);
        expect(() => readAppSettings({ FIRE_AND_FORGET_PER_WORKER: '0' })).toThrow('FIRE_AND_FORGET_PER_WORKER');
    });
});
