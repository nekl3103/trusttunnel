'use strict';
'require view';
'require poll';
'require rpc';
'require trusttunnel.service as service';
'require ui';
'require dom';

var callStatus = rpc.declare({ object: 'luci.trusttunnel', method: 'status' });

var callVersions = rpc.declare({
	object: 'luci.trusttunnel', method: 'versions', params: [ 'refresh' ]
});
var callLog = rpc.declare({
	object: 'luci.trusttunnel', method: 'log', params: [ 'lines' ]
});
var callOverride = rpc.declare({
	object: 'luci.trusttunnel', method: 'multi_override', params: [ 'group', 'server', 'duration' ]
});

// Эта страница отвечает на ОДИН вопрос: работает или нет. Раньше здесь была
// таблица из двенадцати строк — устройство, ip rule, таблица маршрутизации,
// nft-таблица, размер набора обхода, поддержка nftset в dnsmasq. Всё это
// названия внутренних механизмов, а не то, чем человек управляет и что
// узнаёт; судить по ним «работает ли туннель» приходилось самому, сверяя
// зелёные значки между собой.
//
// Теперь состояние сведено в одну фразу с конкретными числами, а разбор по
// звеньям с объяснениями живёт на вкладке «Диагностика» — там он к месту и
// здесь не дублируется.
function verdict(st) {
	var host = st.endpoint_hostname || (st.addresses || [])[0] || '';
	var ls = st.lists_summary || {};
	var full = st.mode === 'full';

	if (!st.client_installed)
		return { level: 'danger',
			head: _('The TrustTunnel client is not installed'),
			detail: _('Run install.sh: the package does not ship the client binary.') };

	// Проверяется РАНЬШЕ состояния службы: без поддержки nftset режим обхода
	// по списку не работает вовсе, сколько бы списков ни было выбрано, а
	// служба при этом выглядит работающей.
	if (!full && !st.dnsmasq_nftset)
		return { level: 'danger',
			head: _('This dnsmasq cannot fill the bypass set'),
			detail: _('Install dnsmasq-full, or switch to "everything through VPN" mode. Nothing is bypassed until then.') };

	if (st.operation_pending)
		return { level: 'warning', head: _('Применяются настройки службы'),
			detail: _('Дождитесь завершения операции.') };

	if (!st.running)
		return st.enabled
			? { level: 'danger', head: _('The service is not running'),
			    detail: _('Press Start and read the client log below.') }
			: { level: 'info', head: _('The service is off'),
			    detail: _('Press Start to run it now, or turn on "Start on boot" in Settings.') };

	if (st.multi_server) {
		var up = (st.servers || []).filter(function(s) { return s.state === 'up'; }).length;
		if (!up)
			return { level: 'danger', head: _('No server is available'),
				detail: _('Check the server configurations and the client log below.') };
		return { level: 'success', head: _('Automatic routing is working'), detail: '' };
	}

	if (!st.device_up)
		return { level: 'warning',
			head: host ? _('Connecting to %s').format(host) : _('Connecting to the server'),
			detail: _('The client is running but the tunnel is not established yet. If this persists, the client log below says why.') };

	if (full)
		return { level: 'success',
			head: host ? _('All LAN traffic goes through %s').format(host)
			           : _('All LAN traffic goes through the tunnel'),
			detail: _('Domains from the "do not bypass" list are sent out directly.') };

	if (!st.set4 || st.set4 < 1)
		return { level: 'warning',
			head: _('The tunnel is up, but nothing is bypassed yet'),
			detail: _('Addresses appear once a device on your network looks up a domain from the selected lists.') };

	// Здесь БЫЛА фраза вида «11 адресов из 18 доменов идут через сервер», и
	// это была ошибка. Слово «из» связало две несвязанные величины: 18 — это
	// сколько домeнов в собранных списках, а 11 — сколько адресов НА ДАННЫЙ
	// МОМЕНТ попало в набор по факту запросов. Читалось как доля, будто семь
	// доменов чего-то не досчитались, и вместо ответа возникал вопрос.
	//
	// Числа остались, но каждое стоит в своей строке таблицы со своей
	// подписью, где видно, что это за величина. А успех сказан одним словом:
	// когда всё работает, подробности не нужны.
	return { level: 'success', head: _('Bypass is working'), detail: '' };
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '30%' }, label),
		E('td', { 'class': 'td left' }, value)
	]);
}

function fmtAge(ts) {
	if (!ts) return _('never');
	var d = Math.floor(Date.now() / 1000) - ts;
	if (d < 60) return _('just now');
	if (d < 3600) return Math.floor(d / 60) + ' ' + _('min ago');
	if (d < 86400) return Math.floor(d / 3600) + ' ' + _('h ago');
	return Math.floor(d / 86400) + ' ' + _('days ago');
}

function reasonText(reason) {
	return ({ fastest: _('самый быстрый'), stable: _('без переключения'), manual: _('задан вручную'),
		override: _('временный выбор'), primary: _('основной сервер'), balanced: _('распределение нагрузки'),
		checking: _('проверяем повторно'),
		unavailable: _('нет доступного сервера') })[reason] || reason || '—';
}

function fmtSpeed(bps) {
	if (!bps) return _('ещё не измерялась');
	return (bps * 8 / 1000000).toFixed(1) + ' Мбит/с';
}

function qualityChart(history) {
	var data = (history || []).slice(-24).map(function(h) { return h.state === 'up' && h.latency < 999999 ? h.latency : null; });
	if (!data.length) return '—';
	var good = data.filter(function(v) { return v != null; });
	if (!good.length) return '—';
	var min = Math.min.apply(null, good), max = Math.max.apply(null, good);
	var points = data.map(function(v, i) {
		var x = data.length === 1 ? 0 : i * 120 / (data.length - 1);
		var y = v == null ? 38 : 36 - ((v - min) / Math.max(1, max - min)) * 30;
		return x.toFixed(1) + ',' + y.toFixed(1);
	}).join(' ');
	return E('svg', { 'viewBox': '0 0 120 40', 'width': '120', 'height': '40',
		'role': 'img', 'aria-label': _('График задержки последних проверок') }, [
		E('polyline', { 'points': points, 'fill': 'none', 'stroke': '#1976d2', 'stroke-width': '2' })
	]);
}

return view.extend({
	handleAction: function(action, ev) {
		var self = this;
		ui.showModal(_('Please wait'), [ E('p', { 'class': 'spinning' }, _('Running…')) ]);
		return service.run(action).then(function(res) {
			ui.hideModal();
			// not_running: собственный код возврата init-скрипта для `start`
			// недостоверен (см. действие service в luci.trusttunnel) — бэкенд
			// перепроверил через procd и ничего работающего не нашёл.
			if (res && res.not_running)
				ui.addNotification(null, E('p', {}, _('The service did not start. The client log below says why.')), 'warning');
			else if (res && res.code !== 0)
				ui.addNotification(null, E('pre', {}, res.output || _('Command failed')), 'warning');
			else
				ui.addNotification(null, E('p', {}, _('Done')), 'info');
			if (self.refreshStatus)
				return self.refreshStatus();
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, e.message || String(e)), 'danger');
		});
	},

	renderActions: function(st) {
		var buttons = [];
		if (st.running) {
			buttons.push(E('button', {
				'class': 'cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(this, 'handleAction', 'stop')
			}, _('Stop')));
			buttons.push(' ');
			buttons.push(E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, 'handleAction', 'restart')
			}, _('Restart')));
		} else {
			buttons.push(E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleAction', 'start')
			}, _('Start')));
		}
		return E('div', {}, buttons);
	},

	// Вердикт и факты отрисовываются ПОРОЗНЬ, потому что живут в разных местах
	// страницы: вердикт занимает всю ширину (это заголовок ответа), а факты
	// стоят в паре с версиями. Опрос обновляет оба блока из одного вызова.
	// Полоса-вердикт показывается ТОЛЬКО когда что-то не так. Тогда она и
	// нужна: там подсказка, что делать, и заметность оправдана. Когда всё
	// работает, полоса во всю ширину сообщала бы «всё хорошо» — то есть
	// занимала бы самое видное место страницы, не давая повода к действию.
	// В этом случае состояние стоит обычной строкой в таблице слева, первой
	// над режимом работы.
	renderVerdict: function(st) {
		var v = verdict(st);
		if (v.level === 'success')
			return E('div', {});
		return E('div', { 'class': 'alert-message ' + v.level },
			v.detail
				? [ E('strong', {}, v.head), E('br'), v.detail ]
				: [ E('strong', {}, v.head) ]);
	},

	renderFacts: function(st) {
		var ls = st.lists_summary || {};
		var v = verdict(st);
		var rows = [];

		// Состояние первой строкой и только при успехе: при отказе о нём
		// говорит полоса выше, и дублировать её здесь незачем.
		if (v.level === 'success')
			rows.push(row(_('State'),
				E('span', { 'style': 'color:#2e7d32;font-weight:bold' }, _('working'))));

		rows.push(row(_('Mode'), st.multi_server ? _('Automatic multi-server routing') : (st.mode === 'full'
			? _('Everything through VPN') : _('Bypass by list'))));

		if (st.multi_server) {
			var up = (st.servers || []).filter(function(s) { return s.state === 'up'; }).length;
			rows.push(row(_('Servers'), _('%d of %d available').format(up, (st.servers || []).length)));
			rows.push(row(_('Site groups'), _('%d active').format((st.groups || []).length)));
			rows.push(row(_('Маршрутизация по устройствам'), st.device_routing ? _('Включена') : _('Выключена')));
			return E('table', { 'class': 'table' }, rows);
		}

		if (st.endpoint_hostname)
			rows.push(row(_('Server'), E('code', {}, st.endpoint_hostname)));

		// Списки и набор показываются только там, где они участвуют: в режиме
		// «всё через VPN» это были бы цифры, ни на что не влияющие.
		if (st.mode !== 'full') {
			// Домены и подсети — это РАЗМЕР СОБРАННЫХ СПИСКОВ, то есть сколько
			// записей вообще подлежит обходу.
			rows.push(row(_('In the lists'),
				_('%d domains').format(ls.domains || 0) +
				((ls.cidr4 || 0) + (ls.cidr6 || 0)
					? ', ' + _('%d subnets').format((ls.cidr4 || 0) + (ls.cidr6 || 0))
					: '') +
				(ls.subtracted
					? ' · ' + _('%d removed by the "do not bypass" list').format(ls.subtracted)
					: '')));

			// А это СОВСЕМ ДРУГАЯ величина: сколько адресов dnsmasq успел
			// положить в набор по факту запросов. Она растёт по мере обращений
			// и не связана с числом доменов никаким отношением — поэтому стоит
			// отдельной строкой со своей подписью, а не рядом через «из».
			// Практическая польза: ноль здесь при работающей службе означает,
			// что dnsmasq набор не наполняет.
			if (st.set4 >= 0)
				rows.push(row(_('Resolved into the bypass set'),
					_('%d addresses').format(st.set4)));

			rows.push(row(_('Lists updated'), fmtAge(st.lists_updated)));
		}

		return E('table', { 'class': 'table' }, rows);
	},

	renderServers: function(st) {
		var self = this;
		this.pendingOverrides = this.pendingOverrides || {};
		var names = {};
		(st.servers || []).forEach(function(s) { names[s.id] = s.name; });
		var rows = [ E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th left' }, _('Server')),
			E('th', { 'class': 'th left' }, _('State')),
			E('th', { 'class': 'th left' }, _('Latency')),
			E('th', { 'class': 'th left' }, _('Скорость')),
			E('th', { 'class': 'th left' }, _('Надёжность')),
			E('th', { 'class': 'th left' }, _('Recent quality')),
			E('th', { 'class': 'th left' }, _('Device'))
		]) ];
		(st.servers || []).forEach(function(s) {
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, s.name),
				E('td', { 'class': 'td left' }, s.state === 'up'
					? E('span', { 'style': 'color:' + (s.failures ? '#b77900' : '#2e7d32') + ';font-weight:bold' }, s.failures ? _('Проверяем повторно (%d/3)').format(s.failures) : _('available'))
					: E('span', { 'style': 'color:#c62828;font-weight:bold' }, _('unavailable'))),
				E('td', { 'class': 'td left' }, s.state === 'up' ? s.latency + ' ms' : '—'),
				E('td', { 'class': 'td left' }, fmtSpeed(s.speed)),
				E('td', { 'class': 'td left' }, (s.success || 0) + '%'),
				E('td', { 'class': 'td left', 'title': _('Latest checks') }, qualityChart(s.history)),
				E('td', { 'class': 'td left' }, s.device || '—')
			]));
		});
		var groups = (st.groups || []).map(function(g) {
			var select = E('select', { 'class': 'cbi-input-select' }, [ E('option', { 'value': 'auto' }, _('По сохранённым настройкам')) ]);
			(st.servers || []).forEach(function(s) { select.appendChild(E('option', { 'value': s.id }, s.name)); });
			select.value = self.pendingOverrides[g.id] || (g.override ? g.override.server : 'auto');
			select.addEventListener('change', function() { self.pendingOverrides[g.id] = select.value; });
			var apply = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button' }, _('Apply for 30 min'));
			apply.addEventListener('click', function() {
				apply.disabled = true;
				callOverride(g.id, select.value, 1800).then(function(res) {
					if (res.error) throw new Error(res.error);
					delete self.pendingOverrides[g.id];
					ui.addNotification(null, E('p', {}, _('Routing override applied')), 'info');
					return self.refreshStatus();
				}).catch(function(e) { ui.addNotification(null, E('p', {}, e.message || String(e)), 'danger'); })
				.finally(function() { apply.disabled = false; });
			});
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, g.name),
				E('td', { 'class': 'td left' }, g.server ? (names[g.server] || g.server) : _('no healthy server')),
				E('td', { 'class': 'td left' }, [ reasonText(g.reason || g.strategy),
					E('small', { 'style': 'display:block;opacity:.7' }, _('Сохранено: ') + (g.strategy === 'manual' ? (names[g.configured_server] || g.configured_server || '—') : (g.strategy === 'auto' ? _('Автоматически') : reasonText(g.strategy)))),
					g.override ? E('small', { 'style': 'display:block;opacity:.7' }, _('Временный выбор: ') + (names[g.override.server] || g.override.server) + (g.override.until ? _(' · осталось %d мин').format(Math.max(0, Math.ceil((g.override.until - Date.now() / 1000) / 60))) : '')) : '',
					g.check ? E('small', { 'style': 'display:block;opacity:.7' },
						g.check.state === 'ok' ? _('сайт доступен') : (g.check.state === 'restricted' ? _('сайт отвечает HTTP %d; доступ ограничен').format(g.check.http_code || 403) : _('контрольный сайт недоступен'))) : '' ]),
				E('td', { 'class': 'td left' }, fmtAge(g.changed)),
				E('td', { 'class': 'td left' }, [ select, ' ', apply ])
			]);
		});
		var switchRows = (st.switches || []).slice(-10).reverse().map(function(x) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, fmtAge(x.at)),
				E('td', { 'class': 'td left' }, x.group),
				E('td', { 'class': 'td left' }, (names[x.from] || x.from || '—') + ' → ' + (names[x.to] || x.to || '—')),
				E('td', { 'class': 'td left' }, reasonText(x.reason))
			]);
		});
		return E('div', {}, [
			E('table', { 'class': 'table' }, rows),
			groups.length ? E('div', { 'style': 'margin-top:1em' }, [ E('h4', {}, _('Group routing')),
				E('table', { 'class': 'table' }, [ E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('Group')), E('th', { 'class': 'th left' }, _('Server')),
					E('th', { 'class': 'th left' }, _('Reason')), E('th', { 'class': 'th left' }, _('Changed')),
					E('th', { 'class': 'th left' }, _('Temporary override'))
				]) ].concat(groups)) ]) : '',
			switchRows.length ? E('div', { 'style': 'margin-top:1em' }, [ E('h4', {}, _('Журнал переключений')),
				E('table', { 'class': 'table' }, [ E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('Когда')), E('th', { 'class': 'th left' }, _('Группа')),
					E('th', { 'class': 'th left' }, _('Переключение')), E('th', { 'class': 'th left' }, _('Причина'))
				]) ].concat(switchRows)) ]) : ''
		]);
	},

	renderVersions: function(v, box) {
		var self = this;

		// Компонентов два — пакет и клиент TrustTunnel, — и релизы у них
		// независимые: клиент выходит у вендора, пакет здесь. Раньше вердикт
		// «обновление / актуально» был один и относился только к пакету, а
		// клиент лишь показывал номер, поэтому вышедший у вендора 1.1.5
		// оставался невидимым при честном «актуальная версия» рядом. Теперь у
		// каждого своя строка: версия и сразу за ней — что с ней.
		//
		// latest == null означает «проверить не удалось»: ни сети, ни кэша,
		// либо у репозитория ещё нет ни одного релиза. Это НЕ то же самое,
		// что «обновлений нет», и говорить об этом надо разными словами —
		// иначе человек решит, что он на свежей версии, хотя проверки не было.
		// Установленное новее последнего известного релиза — тоже не
		// «актуальная версия», а особый случай: либо сборка из main, либо
		// кэш, который не удалось обновить. Своими словами, а не общим
		// успокаивающим ответом.
		function state(latest, upd, ahead) {
			if (latest == null)
				return E('em', {}, _('not checked'));
			if (upd)
				return E('strong', {}, _('%s is available').format(latest));
			if (ahead)
				return _('the installed version is newer than the latest release (%s)').format(latest);
			return _('up to date');
		}
		function verRow(label, installed, missing, st) {
			return row(label, installed
				? E('span', {}, [ installed, ' — ', st ])
				: E('em', {}, missing));
		}

		var rows = [
			verRow(_('Package'), v.package, _('unknown'),
				state(v.latest, v.update_available, v.ahead)),
			verRow(_('TrustTunnel client'), v.client, _('not installed'),
				state(v.client_latest, v.client_update_available, v.client_ahead))
		];

		// Пояснения под таблицей — по одному на ситуацию, а не на компонент:
		// install.sh обновляет обоих сразу, а «GitHub недоступен» относится к
		// проверке целиком.
		var notes = [];
		if (v.update_available || v.client_update_available)
			notes.push(_('Run install.sh again to update: it refreshes both the package and the client.'));
		if (v.stale || v.client_stale)
			notes.push(_('GitHub unreachable, showing the last cached result'));
		if ((v.package && v.latest == null) || (v.client && v.client_latest == null))
			notes.push(_('Update check unavailable: no network and no cached result'));

		var parts = [ E('table', { 'class': 'table' }, rows) ];
		if (notes.length)
			parts.push(E('div', { 'style': 'margin-top:.5em' }, notes.map(function(t) {
				return E('p', { 'style': 'margin:0' }, t);
			})));

		// Кнопка обязательна именно потому, что ответ кэшируется: без неё
		// единственный способ узнать о вышедшем релизе раньше, чем истечёт
		// кэш, — перезагрузить роутер (кэш лежит в /var, то есть в tmpfs).
		parts.push(E('div', { 'style': 'margin-top:.5em' }, E('button', {
			'class': 'cbi-button cbi-button-neutral',
			'click': ui.createHandlerFn(this, function() {
				return callVersions(true).then(function(nv) {
					dom.content(box, self.renderVersions(nv, box));
				}).catch(function(e) {
					ui.addNotification(null, E('p', {}, e.message || String(e)), 'danger');
				});
			})
		}, _('Check now'))));

		return E('div', {}, parts);
	},

	load: function() {
		return callStatus();
	},

	render: function(st) {
		var self = this;
		var verdictBox = E('div', {}, this.renderVerdict(st));
		var factsBox = E('div', {}, this.renderFacts(st));
		var serversBox = E('div', {}, this.renderServers(st));
		var actionsBox = E('div', {}, this.renderActions(st));
		var serversSection = E('div', { 'class': 'cbi-section' },
			st.multi_server && st.running && (st.servers || []).length
				? [ E('h3', {}, _('Servers and routing')), serversBox ] : []);
		var versionBox = E('div', {}, E('em', {}, _('Checking…')));
		var logBox = E('pre', {
			'style': 'max-height:22em;overflow:auto;margin:0'
		}, '');
		var logSummary = E('p', {}, _('Загрузка журнала…'));
		var historyLog = E('pre', { 'style': 'max-height:18em;overflow:auto' }, '');
		var historyDetails = E('details', { 'style': 'display:none' }, [ E('summary', {}, _('Предыдущие записи журнала')), historyLog ]);

		// Версии запрашиваются ОДИН раз при отрисовке, а не через poll:
		// сетевая часть кэшируется на сутки, и повторять даже кэшированный
		// вызов каждые десять секунд незачем.
		callVersions(false).then(function(v) {
			dom.content(versionBox, self.renderVersions(v, versionBox));
		}).catch(function(e) {
			dom.content(versionBox, E('em', {}, e.message || String(e)));
		});

		// 10 с, а не 5: каждый опрос состояния считает на бэкенде размер
		// наборов обхода. При заполненном списком наборе это самая тяжёлая
		// операция пакета, и удвоенный интервал вдвое снижает нагрузку без
		// заметной потери отзывчивости.
		this.refreshStatus = function() {
			return callStatus().then(function(s) {
				dom.content(verdictBox, self.renderVerdict(s));
				dom.content(factsBox, self.renderFacts(s));
				dom.content(serversBox, self.renderServers(s));
				dom.content(actionsBox, self.renderActions(s));
				dom.content(serversSection,
					s.multi_server && s.running && (s.servers || []).length
						? [ E('h3', {}, _('Servers and routing')), serversBox ] : []);
			});
		};
		poll.add(this.refreshStatus, 10);

		var refreshLog = function() {
			return callLog(80).then(function(r) {
				var current = (r.lines || []).join('\n'), history = (r.history || []).join('\n');
				if (logBox.textContent !== current) logBox.textContent = current;
				if (historyLog.textContent !== history) historyLog.textContent = history;
				historyDetails.style.display = history ? '' : 'none';
				logSummary.textContent = r.last_error ? _('Последняя ошибка в показанных записях: ') + r.last_error : _('В последних записях текущего сеанса ошибок нет.');
			});
		};
		refreshLog();
		poll.add(refreshLog, 30);

		// Два блока рядом через flex-wrap, а НЕ через сетку с media-запросами:
		// оба узкие и самостоятельные, а flex-basis заставляет их встать в
		// столбик на телефоне сам, без своего CSS. Это тот же приём, которым
		// размечены строки формы в самой теме (.cbi-value — display:flex).
		//
		// Форму так делить нельзя: её строки УЖЕ двухколоночные (метка 180px +
		// поле), а содержимое ограничено 1180px, поэтому вторая колонка
		// оставила бы полю около 370px и сплющила пояснения под ним.
		var pair = E('div', {
			'style': 'display:flex;flex-wrap:wrap;gap:0 1.5em'
		}, [
			E('div', { 'style': 'flex:1 1 24em;min-width:0' }, [
				E('h3', {}, _('Now')),
				factsBox
			]),
			E('div', { 'style': 'flex:1 1 24em;min-width:0' }, [
				E('h3', {}, _('Versions')),
				versionBox
			])
		]);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('TrustTunnel')),

			E('div', { 'class': 'cbi-section' }, [
				verdictBox,
				E('div', { 'style': 'margin-top:1em' }, [ actionsBox ])
			]),

			E('div', { 'class': 'cbi-section' }, [ pair ]),

			serversSection,

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Client log')),
				logSummary, logBox, historyDetails
			])
		]);
	}
});
