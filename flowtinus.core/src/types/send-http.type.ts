import type { HttpRequest } from '#types/http-request.type';
import type { HttpResponse } from '#types/http-response.type';

export type SendHttp = (request: HttpRequest) => Promise<HttpResponse>;
