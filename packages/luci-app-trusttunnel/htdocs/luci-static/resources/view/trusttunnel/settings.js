'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require trusttunnel.service as service';
'require ui';
'require validation';

var callImport = rpc.declare({
	object: 'luci.trusttunnel', method: 'import_config', params: [ 'text' ]
});
var callCatalog = rpc.declare({
	object: 'luci.trusttunnel', method: 'catalog', params: [ 'refresh' ]
});
var callGeositeCatalog = rpc.declare({
	object: 'luci.trusttunnel', method: 'geosite_catalog', params: [ 'refresh', 'names' ]
});

var callSecretSet = rpc.declare({
	object: 'luci.trusttunnel', method: 'secret_set', params: [ 'server', 'password' ]
});
var callHostHints = rpc.declare({
	object: 'luci-rpc', method: 'getHostHints', expect: { '': {} }
});

// Форматы под другие движки бэкенд уже отфильтровал; оставшиеся имена
// показываем как есть, чтобы не расходиться с содержимым репозитория.
function isSubnet(path) {
	return path.indexOf('Subnets/') === 0;
}

function baseName(path) {
	return path.split('/').pop().replace(/\.lst$/, '');
}

// Схлопывает Subnets/IPv4 и Subnets/IPv6 в ОДНУ группу, где строка на сервис,
// а не на файл. Дублирование в исходном каталоге двойное, и оба вида здесь
// снимаются.
//
// Первое: репозиторий держит часть файлов в двух экземплярах, отличающихся
// только регистром имени — Subnets/IPv4/Meta.lst и Subnets/IPv4/meta.lst байт
// в байт одинаковы, то же с Twitter и Discord. Показывать их как два разных
// списка значит предлагать выбор, которого нет.
//
// Второе: семейства адресов лежат в отдельных каталогах, но решение о них
// одно. После нормализации регистра имён в IPv4 одиннадцать, в IPv6 десять, и
// расходится ровно roblox — для остальных десяти две галочки всегда означали
// одно и то же. Поэтому строка выбирает сразу оба файла, а несимметричный
// сервис помечается, чтобы отсутствие половины не выглядело нашей потерей.
//
// Канонический путь на семейство берётся из ФАКТИЧЕСКИ имеющихся в каталоге,
// с предпочтением строчного имени: сочинять meta.lst там, где в репозитории
// остался только Meta.lst, нельзя — fetch-lists печатал бы по такому пути
// `fail` при каждом обновлении списков.
function collapseSubnets(groups) {
	var families = { 'Subnets/IPv4': 'IPv4', 'Subnets/IPv6': 'IPv6' };
	var merged = null, out = [], byName = {};

	groups.forEach(function(g) {
		if (!families[g.name]) { out.push(g); return; }
		if (!merged) {
			merged = { name: 'Subnets', files: [], collapsed: true };
			out.push(merged);
		}
		g.files.forEach(function(f) {
			var name = baseName(f.path).toLowerCase();
			var item = byName[name];
			if (!item) {
				item = byName[name] = { name: name, paths: {}, sizes: {}, families: [] };
				merged.files.push(item);
			}
			var fam = families[g.name];
			// Строчное имя вытесняет вариант с заглавной; обратное — нет.
			// Так из пары одинаковых файлов остаётся один и тот же
			// независимо от порядка, в котором их отдал GitHub.
			var isLower = baseName(f.path) === name;
			if (!item.paths[fam] || isLower) {
				item.paths[fam] = f.path;
				item.sizes[fam] = f.size || 0;
			}
			if (item.families.indexOf(fam) < 0) item.families.push(fam);
		});
	});

	if (merged)
		merged.files.forEach(function(item) {
			item.families.sort();
			item.allPaths = item.families.map(function(fam) { return item.paths[fam]; });
			item.size = item.families.reduce(function(sum, fam) {
				return sum + item.sizes[fam];
			}, 0);
		});

	return out;
}

// Все настройки собраны на ОДНОЙ странице с вкладками, а не разложены по
// отдельным пунктам меню. Причина не в экономии: в LuCI каждый пункт меню —
// это отдельная страница, и переход между ними перезагружает всю оболочку
// целиком. Настройка пакета — это один сеанс работы (задать сервер, выбрать
// списки, добавить свои домены), и разрывать его тремя перезагрузками
// неправильно. Штатные страницы LuCI устроены так же: «Система» держит пять
// вкладок в одной странице, «DHCP и DNS» и «Интерфейсы» — тоже.
//
// Механизм: m.tabbed = true превращает каждую секцию в вкладку, а её заголовок
// становится названием вкладки. Переключение происходит в браузере, без запроса
// к роутеру.
return view.extend({
	load: function() {
		var self = this;
		var config = uci.load('trusttunnel').then(function() {
			self.serverIds = uci.sections('trusttunnel', 'server').map(function(s) { return s['.name']; });
		});
		return Promise.all([
			config,
			config.then(function() {
				var names = [];
				uci.sections('trusttunnel', 'group', function(g) {
					L.toArray(g.source).forEach(function(path) {
						var match = path.match(/^Geosite\/(.+)\.lst$/);
						if (match) names.push(match[1]);
					});
					var aliases = { youtube: 'youtube', telegram: 'telegram', openai: 'openai', chatgpt: 'openai', 'chatgpt / openai': 'openai' };
					var alias = aliases[(g.name || '').toLowerCase()];
					if (alias && names.indexOf(alias) < 0) names.push(alias);
				});
				return callGeositeCatalog(false, names.join(',') || '-');
			}).catch(function(e) { return { error: e.message }; }),
			callHostHints().catch(function() { return {}; })
		]);
	},

	handleImport: function(sectionID) {
		if (typeof sectionID !== 'string' || !/^[A-Za-z0-9_]+$/.test(sectionID)) {
			ui.addNotification(null, E('p', {},
				_('Could not create a server entry. Reload the page and try again.')), 'danger');
			return Promise.resolve();
		}
		var ta = E('textarea', {
			'rows': 14, 'style': 'width:100%',
			'placeholder': _('Paste the endpoint configuration generated by your server')
		});
		ui.showModal(_('Import endpoint configuration'), [
			E('p', {}, _('Accepts both forms a server hands out: the configuration file text and a tt:// link. Nothing is saved until you press Save & Apply.')),
			ta,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(this, function() {
						return callImport(ta.value).then(function(res) {
							if (res.error) {
								ui.addNotification(null, E('p', {}, res.error), 'danger');
								return;
							}
							var target = sectionID || 'endpoint';
							// A newly generated anonymous section has no human name yet.
							// Fill it from the imported TLS hostname so the required Name
							// field cannot turn uci.save() into an invalid empty set call.
							if (!uci.get('trusttunnel', target, 'name'))
								uci.set('trusttunnel', target, 'name', res.hostname || target);
							uci.set('trusttunnel', target, 'enabled', '1');
							[ 'hostname', 'username', 'certificate', 'custom_sni',
							  'client_random', 'protocol', 'skip_verification', 'anti_dpi',
							  'has_ipv6' ].forEach(function(k) {
								if (res[k] != null)
									uci.set('trusttunnel', target, k, res[k]);
							});
							if (res.addresses && res.addresses.length)
								uci.set('trusttunnel', target, 'address', res.addresses);
							if (res.dns_upstreams && res.dns_upstreams.length)
								uci.set('trusttunnel', target, 'dns_upstream', res.dns_upstreams);

							// Остальные поля сервера. Флаг has_ipv6 берётся
							// только положительным: setup_wizard печатает
							// false и тогда, когда сервер поле не задал, —
							// отличить «нет IPv6» от «не сказано» нельзя, а
							// умолчание пакета («есть») безопаснее ошибочного
							// «нет». У skip_verification и anti_dpi такой
							// проблемы нет: их «не задано» и есть false.
							// uci.set() держит изменения только в памяти
							// браузера. Перезагрузка страницы их выбрасывает,
							// поэтому прежний вариант (set + location.reload)
							// показывал «импортировано», а через 800 мс молча
							// возвращал прежние значения — импорт выглядел
							// работающим и не работал.
							//
							// uci.save() отправляет изменения на роутер как
							// ОТЛОЖЕННЫЕ: конфиг не применяется, службы не
							// перезапускаются, LuCI показывает «есть
							// несохранённые изменения». После перезагрузки
							// страницы поля показывают импортированное, а
							// применяет их пользователь сам — то есть условие
							// «импорт ничего не применяет» соблюдено.
							var secret = res.password ? callSecretSet(target, res.password) : Promise.resolve({ kept: true });
							return secret.then(function(sr) {
								if (sr && sr.error) throw new Error(sr.error);
								return uci.save();
							}).then(function() {
								ui.hideModal();
								ui.addNotification(null, E('p', {},
									_('Imported. Review the fields and press Save & Apply.')), 'info');
								window.setTimeout(function() { location.reload(); }, 800);
							});
						}).catch(function(e) {
							ui.addNotification(null, E('p', {}, e.message || String(e)), 'danger');
						});
					})
				}, _('Import'))
			])
		]);
	},

	handleUpdateLists: function() {
		ui.showModal(_('Please wait'), [
			E('p', { 'class': 'spinning' }, _('Downloading the lists and regenerating the rules…'))
		]);
		return service.run('update_lists').then(function(res) {
			ui.hideModal();
			ui.addNotification(null, E('pre', {}, res.output || _('Done')),
				res.code === 0 ? 'info' : 'warning');
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, e.message), 'danger');
		});
	},

	handleRefreshCatalog: function() {
		ui.showModal(_('Please wait'), [
			E('p', { 'class': 'spinning' }, _('Refreshing the catalog from GitHub…'))
		]);
		return callCatalog(true).then(function() {
			ui.hideModal();
			location.reload();
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, e.message), 'danger');
		});
	},

	handleRefreshGeosite: function() {
		ui.showModal(_('Please wait'), [
			E('p', { 'class': 'spinning' }, _('Refreshing geosite categories…'))
		]);
		return callGeositeCatalog(true).then(function() {
			ui.hideModal();
			location.reload();
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', {}, e.message), 'danger');
		});
	},

	renderGeositeCatalog: function(catalog) {
		var self = this;
		var existing = {};
		uci.sections('trusttunnel', 'group', function(g) {
			var geosite = false;
			L.toArray(g.source).forEach(function(path) {
				var match = path.match(/^Geosite\/(.+)\.lst$/);
				if (match) { existing[match[1]] = g; geosite = true; }
			});
			if (!geosite) {
				var aliases = { youtube: 'youtube', telegram: 'telegram', openai: 'openai',
					chatgpt: 'openai', 'chatgpt / openai': 'openai' };
				var key = aliases[(g.name || '').toLowerCase()];
				if (key && !existing[key]) existing[key] = g;
			}
		});
		var servers = uci.sections('trusttunnel', 'server').filter(function(s) { return s.enabled !== '0'; });
		var titles = { openai: 'ChatGPT / OpenAI', youtube: 'YouTube', instagram: 'Instagram',
			telegram: 'Telegram', twitter: 'X / Twitter', github: 'GitHub' };
		function titleFor(name) { return titles[name] || name.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }); }
		var items = (catalog.items || []).slice();
		Object.keys(existing).forEach(function(name) {
			if (!items.some(function(item) { return item.name === name; })) items.push({ name: name });
		});
		items.sort(function(a, b) { return titleFor(a.name).localeCompare(titleFor(b.name)); });
		this.geositeControls = [];

		var count = E('span', { 'class': 'tt-groups-count', 'aria-live': 'polite' });
		var search = E('input', { 'type': 'search', 'class': 'cbi-input-text',
			'placeholder': _('Поиск: YouTube, Telegram, OpenAI…'), 'aria-label': _('Поиск группы сайтов') });
		var picker = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Группа сайтов') });
		var add = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-add', 'disabled': '' }, _('Добавить группу'));
		var loadCatalog = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, _('Загрузить полный каталог'));
		var empty = E('div', { 'class': 'tt-groups-empty' }, [
			E('strong', {}, _('Группы ещё не добавлены')),
			E('p', {}, _('Выберите сервис выше и нажмите «Добавить группу». Затем выберите сервер, через который будут открываться его сайты.'))
		]);
		var grid = E('div', { 'class': 'tt-groups-grid' });
		function updatePicker() {
			var selected = picker.value;
			var query = search.value.trim().toLowerCase();
			while (picker.firstChild) picker.removeChild(picker.firstChild);
			picker.appendChild(E('option', { 'value': '' }, _('Выберите группу…')));
			items.forEach(function(item) {
				if (existing[item.name] || (titleFor(item.name) + ' ' + item.name).toLowerCase().indexOf(query) < 0) return;
				picker.appendChild(E('option', { 'value': item.name }, titleFor(item.name) + ' · ' + item.name));
			});
			picker.value = selected;
			if (picker.selectedIndex < 0) picker.value = '';
			add.disabled = !picker.value;
		}
		function updateCount() {
			var active = self.geositeControls.filter(function(c) { return !c.removed; }).length;
			count.textContent = _('Групп: %d').format(active);
			empty.style.display = active ? 'none' : '';
		}
		search.addEventListener('input', updatePicker);
		picker.addEventListener('change', function() { add.disabled = !picker.value; });
		loadCatalog.addEventListener('click', function() {
			loadCatalog.disabled = true;
			loadCatalog.textContent = _('Загрузка каталога…');
			callGeositeCatalog(false, '').then(function(full) {
				if (full.error) throw new Error(full.error);
				(full.items || []).forEach(function(item) {
					var index = items.findIndex(function(old) { return old.name === item.name; });
					if (index < 0) items.push(item); else items[index] = item;
				});
				items.sort(function(a, b) { return titleFor(a.name).localeCompare(titleFor(b.name)); });
				updatePicker();
				loadCatalog.style.display = 'none';
			}).catch(function(e) {
				loadCatalog.disabled = false;
				loadCatalog.textContent = _('Повторить загрузку каталога');
				ui.addNotification(null, E('p', {}, e.message), 'danger');
			});
		});
		function field(title, input, hint) {
			return E('label', { 'class': 'tt-group-field' }, [ E('span', {}, title), input,
				hint ? E('small', {}, hint) : '' ]);
		}
		function renderItem(item) {
			var group = existing[item.name];
			if (group === true) group = null;
			var title = titleFor(item.name);
			var cb = E('input', { 'type': 'checkbox' });
			cb.checked = !group || group.enabled !== '0';
			var route = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'auto' }, _('Автоматический выбор')),
				E('option', { 'value': 'priority' }, _('Основной и резервные')),
				E('option', { 'value': 'balanced' }, _('Распределение между серверами'))
			]);
			servers.forEach(function(s) { route.appendChild(E('option', { 'value': 'fixed:' + s['.name'] }, s.name || s['.name'])); });
			if (group && group.strategy === 'manual' && group.server) {
				if (!servers.some(function(s) { return s['.name'] === group.server; })) {
					var saved = uci.get('trusttunnel', group.server, 'name') || group.server;
					route.appendChild(E('option', { 'value': 'fixed:' + group.server }, saved + ' (' + _('недоступен') + ')'));
				}
				route.value = 'fixed:' + group.server;
			} else if (group && (group.strategy === 'priority' || group.strategy === 'balanced')) route.value = group.strategy;
			var savedPool = group ? L.toArray(group.pool) : [];
			var pool = E('div', { 'class': 'tt-group-pool' });
			var primary = E('select', { 'class': 'cbi-input-select' }, [ E('option', { 'value': '' }, _('Выберите основной сервер')) ]);
			servers.forEach(function(s) {
				var id = s['.name'];
				var check = E('input', { 'type': 'checkbox', 'value': id });
				check.checked = !savedPool.length || savedPool.indexOf(id) >= 0;
				pool.appendChild(E('label', {}, [ check, E('span', {}, s.name || id) ]));
				primary.appendChild(E('option', { 'value': id }, s.name || id));
			});
			if (!servers.length) pool.appendChild(E('small', {}, _('Сначала добавьте и включите сервер на вкладке «Серверы».')));
			if (group && group.primary) primary.value = group.primary;
			var domains = E('textarea', { 'rows': 3, 'class': 'cbi-input-text', 'placeholder': 'example.com\nvideo.example.com' }, group ? L.toArray(group.domain).join('\n') : '');
			var threshold = E('input', { 'type': 'number', 'min': 0, 'class': 'cbi-input-text', 'value': group && group.switch_threshold || '', 'placeholder': _('Общая настройка') });
			var cooldown = E('input', { 'type': 'number', 'min': 0, 'class': 'cbi-input-text', 'value': group && group.switch_cooldown || '', 'placeholder': _('Общая настройка') });
			var metric = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'latency' }, _('Минимальная задержка')),
				E('option', { 'value': 'speed' }, _('Максимальная скорость')),
				E('option', { 'value': 'reliability' }, _('Максимальная надёжность'))
			]);
			metric.value = group && group.metric || 'latency';
			var defaultChecks = { youtube: 'https://www.youtube.com/generate_204', telegram: 'https://telegram.org/favicon.ico',
				openai: 'https://chatgpt.com/favicon.ico', instagram: 'https://www.instagram.com/favicon.ico' };
			var controlUrl = E('input', { 'type': 'url', 'class': 'cbi-input-text',
				'value': group ? group.control_url || '' : defaultChecks[item.name] || '', 'placeholder': 'https://example.com/favicon.ico' });
			var poolField = E('div', { 'class': 'tt-group-field' }, [ E('span', {}, _('Серверы для этой группы')), pool,
				E('small', {}, _('Если не выбран ни один, используются все включённые серверы.')) ]);
			var primaryField = field(_('Основной сервер'), primary, _('При его недоступности используется другой сервер из выбранных.'));
			primaryField.className += ' tt-group-primary';
			var metricField = field(_('Критерий выбора'), metric);
			var thresholdField = field(_('Порог переключения, мс'), threshold);
			var cooldownField = field(_('Пауза между переключениями, секунд'), cooldown);
			var advanced = E('details', { 'class': 'tt-group-options' }, [
				E('summary', {}, _('Дополнительные настройки')),
				E('div', { 'class': 'tt-group-fields' }, [ poolField, metricField, thresholdField, cooldownField,
					field(_('Адрес проверки доступности'), controlUrl, _('Необязательно. Проверяет, открывается ли сервис через сервер.')),
					field(_('Дополнительные домены'), domains, _('По одному домену в строке. Домены категории подключаются автоматически.')) ])
			]);
			var routeHint = E('small', { 'class': 'tt-group-route-hint' });
			function updateRoute() {
				var automatic = route.value.indexOf('fixed:') !== 0;
				poolField.style.display = automatic ? '' : 'none';
				primaryField.style.display = route.value === 'priority' ? '' : 'none';
				metricField.style.display = automatic && route.value !== 'balanced' ? '' : 'none';
				thresholdField.style.display = cooldownField.style.display = automatic && route.value !== 'balanced' ? '' : 'none';
				var hints = {
					auto: _('Сервер выбирается из отмеченных по задержке, скорости или надёжности.'),
					priority: _('Группа использует основной сервер, а при его недоступности — резервный.'),
					balanced: _('Группы распределяются между доступными серверами. Одно соединение идёт через один сервер.')
				};
				routeHint.textContent = hints[route.value] || _('Все сайты этой группы идут через выбранный сервер.');
			}
			route.addEventListener('change', updateRoute);
			updateRoute();
			var status = E('span', { 'class': 'tt-group-status' });
			function updateEnabled() {
				status.textContent = cb.checked ? _('Включена') : _('Выключена');
				status.className = 'tt-group-status' + (cb.checked ? ' tt-group-status-on' : '');
			}
			cb.addEventListener('change', updateEnabled);
			updateEnabled();
			var remove = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-negative' }, _('Удалить'));
			var body = E('div', { 'class': 'tt-group-body' }, [
				E('div', { 'class': 'tt-group-heading' }, [
					E('div', { 'class': 'tt-group-title' }, [ E('strong', {}, title),
						E('small', {}, item.name + (item.count != null ? ' · ' + _('Правил: %d').format(item.applied == null ? item.count : item.applied) : '')) ]),
					status, remove
				]),
				E('div', { 'class': 'tt-group-main' }, [
					E('label', { 'class': 'tt-group-enabled' }, [ cb, E('span', {}, _('Использовать группу')) ]),
					field(_('Через какой сервер открывать сайты'), route), routeHint, primaryField
				]),
				item.ignored ? E('p', { 'class': 'tt-group-note' }, _('Неподдерживаемых правил: %d. Они не участвуют в маршрутизации.').format(item.ignored)) : '',
				advanced
			]);
			var restore = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, _('Вернуть группу'));
			var removed = E('div', { 'class': 'tt-group-removed', 'style': 'display:none', 'role': 'status' }, [
				E('div', {}, [ E('strong', {}, title), E('p', {}, _('Группа будет удалена после сохранения. До этого её можно вернуть.')) ]), restore
			]);
			var card = E('div', { 'class': 'tt-group-card' }, [ body, removed ]);
			var control = { name: item.name, checkbox: cb, route: route, pool: pool, primary: primary,
				domains: domains, threshold: threshold, cooldown: cooldown, metric: metric,
				controlUrl: controlUrl, group: group, card: card, removed: false };
			remove.addEventListener('click', function() {
				control.removed = true; body.style.display = 'none'; removed.style.display = '';
				updateCount(); restore.focus();
			});
			restore.addEventListener('click', function() {
				control.removed = false; body.style.display = ''; removed.style.display = 'none';
				updateCount(); remove.focus();
			});
			grid.appendChild(card);
			self.geositeControls.push(control);
		}
		items.forEach(function(item) { if (existing[item.name]) renderItem(item); });
		add.addEventListener('click', function() {
			var item = items.filter(function(i) { return i.name === picker.value; })[0];
			if (!item || existing[item.name]) return;
			renderItem(item); existing[item.name] = true;
			search.value = ''; updatePicker(); updateCount();
		});
		updatePicker(); updateCount();
		return E('div', { 'class': 'tt-site-groups' }, [
			E('style', {}, '.tt-site-groups{max-width:1100px}.tt-groups-header,.tt-group-heading,.tt-group-removed{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.tt-groups-header h3{margin:0}.tt-groups-count,.tt-group-status{font-size:12px;border:1px solid rgba(127,127,127,.25);border-radius:20px;padding:4px 10px;white-space:nowrap}.tt-group-status-on{color:#20824b;background:rgba(48,160,90,.1);border-color:rgba(48,160,90,.25)}.tt-groups-intro{opacity:.75;margin:8px 0 18px}.tt-groups-add{padding:16px;border:1px solid rgba(127,127,127,.22);border-radius:10px;background:rgba(127,127,127,.04)}.tt-groups-add-row{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.tt-groups-add-row input,.tt-groups-add-row select{flex:1;min-width:180px;max-width:100%;width:auto!important}.tt-groups-grid{display:grid;gap:14px;margin-top:18px}.tt-group-card{border:1px solid rgba(127,127,127,.25);border-radius:12px;overflow:hidden}.tt-group-heading{padding:16px 18px;background:rgba(127,127,127,.05);border-bottom:1px solid rgba(127,127,127,.18)}.tt-group-title{flex:1;min-width:160px}.tt-group-title strong{display:block;font-size:17px}.tt-group-title small{display:block;opacity:.65;margin-top:4px;overflow-wrap:anywhere}.tt-group-main{padding:16px 18px;display:grid;grid-template-columns:minmax(150px,.6fr) minmax(200px,1.4fr);gap:10px 24px;align-items:center}.tt-group-enabled,.tt-group-pool label{display:flex;align-items:center;gap:8px;cursor:pointer}.tt-group-primary{grid-column:2}.tt-group-route-hint{grid-column:2;opacity:.7;line-height:1.5}.tt-group-field{display:flex;flex-direction:column;gap:7px;min-width:0}.tt-group-field>span{font-weight:600}.tt-group-field small{opacity:.7;line-height:1.5}.tt-group-field input:not([type=checkbox]),.tt-group-field select,.tt-group-field textarea{width:100%!important;max-width:100%;box-sizing:border-box}.tt-group-pool{display:flex;flex-wrap:wrap;gap:8px 18px}.tt-group-options{border-top:1px solid rgba(127,127,127,.18);padding:0 18px}.tt-group-options summary{cursor:pointer;padding:14px 0;font-weight:600}.tt-group-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;padding:4px 0 20px}.tt-group-note{padding:0 18px;opacity:.7}.tt-group-removed{padding:18px;background:rgba(127,127,127,.05)}.tt-group-removed p{margin:6px 0 0;opacity:.7}.tt-groups-empty{text-align:center;padding:28px 18px;border:1px dashed rgba(127,127,127,.3);border-radius:10px;margin-top:18px}.tt-groups-empty p{opacity:.7}.tt-groups-footer{margin-top:16px;opacity:.75;font-size:13px}@media(max-width:600px){.tt-group-main{grid-template-columns:1fr}.tt-group-route-hint,.tt-group-primary{grid-column:1}.tt-groups-add-row{flex-direction:column}.tt-groups-add-row input,.tt-groups-add-row select{min-width:0;width:100%!important}.tt-group-fields{grid-template-columns:1fr}.tt-group-heading{gap:10px}.tt-group-title{flex-basis:100%}}'),
			E('div', { 'class': 'tt-groups-header' }, [ E('h3', {}, _('Ваши группы сайтов')), count ]),
			E('p', { 'class': 'tt-groups-intro' }, _('Добавьте нужные сервисы и выберите сервер для каждого. Остальные сайты открываются напрямую.')),
			catalog.error ? E('p', { 'class': 'alert-message warning' }, catalog.error) : '',
			!servers.length ? E('p', { 'class': 'alert-message warning' }, _('Нет включённых серверов. Добавьте сервер на вкладке «Серверы», сохраните настройки и вернитесь к группам.')) : '',
			E('div', { 'class': 'tt-groups-add' }, [ E('strong', {}, _('Добавить сервис или категорию')), E('div', { 'class': 'tt-groups-add-row' }, [ search, picker, add ]), loadCatalog ]),
			empty, grid,
			E('p', { 'class': 'tt-groups-footer' }, _('Добавление, отключение и удаление групп вступают в силу после «Сохранить и применить». Отключённая группа сохраняет настройки.'))
		]);
	},

	collectGeositeGroups: function() {
		if (!this.geositeControls) return;
		var activeServers = uci.sections('trusttunnel', 'server').filter(function(s) {
			return s.enabled !== '0';
		}).map(function(s) { return s['.name']; });
		this.geositeControls.forEach(function(c) {
			var sid = c.group && c.group['.name'];
			if (c.removed) {
				if (sid) {
					uci.remove('trusttunnel', sid);
					uci.sections('trusttunnel', 'device', function(device) {
						var groups = L.toArray(device.group).filter(function(id) { return id !== sid; });
						uci.set('trusttunnel', device['.name'], 'group', groups.length ? groups : '');
					});
				}
				return;
			}
			if (!sid) {
				sid = uci.add('trusttunnel', 'group', 'grp_' + c.name.replace(/[^A-Za-z0-9_]/g, '_') + '_' + Date.now().toString(16));
				c.group = { '.name': sid };
			}
			uci.set('trusttunnel', sid, 'enabled', c.checkbox.checked ? '1' : '0');
			uci.set('trusttunnel', sid, 'name', c.name);
			uci.set('trusttunnel', sid, 'source', [ 'Geosite/' + c.name + '.lst' ]);
			var chosenPool = Array.prototype.map.call(c.pool.querySelectorAll('input:checked'), function(input) { return input.value; });
			var customDomains = c.domains.value.split(/\s+/).map(function(v) { return v.trim().toLowerCase(); }).filter(Boolean);
			uci.set('trusttunnel', sid, 'domain', customDomains.length ? customDomains : '');
			uci.set('trusttunnel', sid, 'switch_threshold', c.threshold.value || '');
			uci.set('trusttunnel', sid, 'switch_cooldown', c.cooldown.value || '');
			uci.set('trusttunnel', sid, 'metric', c.metric.value || 'latency');
			uci.set('trusttunnel', sid, 'control_url', c.controlUrl.value || '');
			if (c.route.value === 'auto' || c.route.value === 'priority' || c.route.value === 'balanced') {
				uci.set('trusttunnel', sid, 'strategy', c.route.value);
				uci.set('trusttunnel', sid, 'server', '');
				uci.set('trusttunnel', sid, 'pool', chosenPool.length ? chosenPool : activeServers);
				uci.set('trusttunnel', sid, 'primary', c.primary.value || '');
			} else {
				uci.set('trusttunnel', sid, 'strategy', 'manual');
				uci.set('trusttunnel', sid, 'server', c.route.value.replace(/^fixed:/, ''));
				uci.set('trusttunnel', sid, 'pool', chosenPool.length ? chosenPool : activeServers);
				uci.set('trusttunnel', sid, 'primary', '');
			}
		});
	},

	renderCatalog: function(catalog) {
		if (catalog.error)
			return E('div', { 'class': 'alert-message warning' }, [
				E('p', {}, _('The list catalog could not be loaded, so the choices below are unavailable.')),
				E('p', {}, catalog.error),
				E('p', {}, _('Already selected lists keep working — they are stored on the router.'))
			]);

		var selectedSources = L.toArray(uci.get('trusttunnel', 'lists', 'source'));
		var selectedSubnets = L.toArray(uci.get('trusttunnel', 'lists', 'subnet'));
		var self = this;
		this.checkboxes = [];

		// Выбранным считается сервис, у которого отмечен ЛЮБОЙ вариант пути,
		// включая старый регистр и одно семейство из двух. Иначе после
		// схлопывания строк выбор человека выглядел бы потерянным, а
		// сохранение его бы и потеряло.
		function anySelected(paths, saved) {
			var keys = {};
			saved.forEach(function(p) { keys[p.toLowerCase()] = true; });
			return paths.some(function(p) { return keys[p.toLowerCase()]; });
		}

		var groups = collapseSubnets(catalog.groups || []).map(function(g) {
			var items = g.files.map(function(f) {
				var subnet = g.collapsed || isSubnet(f.path);
				var list = subnet ? selectedSubnets : selectedSources;
				// Строка объединённой группы несёт ОБА пути семейств, а не
				// один: `collect` разбирает их по пробелу.
				var paths = f.allPaths || [ f.path ];
				var cb = E('input', {
					'type': 'checkbox',
					'data-path': paths.join(' '),
					'data-kind': subnet ? 'subnet' : 'source'
				});
				if (anySelected(paths, list))
					cb.checked = true;
				self.checkboxes.push(cb);
				var name = f.name || baseName(f.path);
				var label = [ cb, ' ', name, ' ',
					E('span', { 'style': 'opacity:.6' },
						Math.round(f.size / 1024) + ' KiB') ];
				// Пометка появляется только у несимметричного сервиса (в
				// каталоге это один roblox, у него нет файла IPv6). Без неё
				// отсутствие половины читалось бы как наша потеря.
				if (f.families && f.families.length === 1)
					label.push(E('span', { 'style': 'opacity:.6' },
						' · ' + _('%s only').format(f.families[0])));
				return E('label', {
					'style': 'display:inline-block;min-width:17em;margin:.15em 0'
				}, label);
			});
			return E('div', { 'style': 'margin-bottom:.9em' }, [
				E('strong', {}, g.name),
				E('div', { 'style': 'margin-top:.2em' }, items)
			]);
		});

		if (catalog.stale)
			groups.unshift(E('div', { 'class': 'alert-message warning' },
				_('GitHub is unreachable, so this catalog is the last cached copy. Newly published lists may be missing.')));

		if (!groups.length)
			groups.push(E('em', {}, _('The catalog is empty.')));

		return E('div', {}, groups);
	},

	handleSaveApply: function(ev, mode) {
		this.collect();
		return this.super('handleSaveApply', [ ev, mode ]);
	},

	handleSave: function(ev) {
		this.collect();
		return this.super('handleSave', [ ev ]);
	},


	syncGroupServers: function() {
		var servers = uci.sections('trusttunnel', 'server');
		var ids = servers.map(function(s) { return s['.name']; });
		var added = ids.filter(function(id) { return (this.serverIds || ids).indexOf(id) < 0; }, this);
		function exists(id) { return ids.indexOf(id) >= 0; }
		(this.geositeControls || []).forEach(function(c) {
			if (c.route.value.indexOf('fixed:') === 0 && !exists(c.route.value.slice(6))) c.route.value = 'auto';
			if (c.primary.value && !exists(c.primary.value)) c.primary.value = '';
			[c.route, c.primary].forEach(function(select) {
				Array.prototype.forEach.call(select.querySelectorAll('option'), function(option) {
					var id = select === c.route ? (option.value.indexOf('fixed:') === 0 ? option.value.slice(6) : '') : option.value;
					if (id && !exists(id)) option.remove();
				});
			});
			Array.prototype.forEach.call(c.pool.querySelectorAll('input'), function(input) {
				if (!exists(input.value)) input.parentNode.remove();
			});
			added.forEach(function(id) {
				var server = servers.filter(function(s) { return s['.name'] === id; })[0];
				var check = E('input', { 'type': 'checkbox', 'value': id });
				check.checked = true;
				c.pool.appendChild(E('label', {}, [ check, E('span', {}, server.name || id) ]));
				c.route.appendChild(E('option', { 'value': 'fixed:' + id }, server.name || id));
				c.primary.appendChild(E('option', { 'value': id }, server.name || id));
			});
		});
		this.collectGeositeGroups();
		uci.sections('trusttunnel', 'group', function(g) {
			var savedPool = L.toArray(g.pool);
			var pool = (savedPool.length ? savedPool : ids).filter(exists);
			added.forEach(function(id) { if (pool.indexOf(id) < 0) pool.push(id); });
			uci.set('trusttunnel', g['.name'], 'pool', pool.length ? pool : '');
			if (g.server && !exists(g.server)) {
				uci.unset('trusttunnel', g['.name'], 'server');
				if (g.strategy === 'manual') uci.set('trusttunnel', g['.name'], 'strategy', 'auto');
			}
			if (g.primary && !exists(g.primary)) uci.unset('trusttunnel', g['.name'], 'primary');
		});
		this.serverIds = ids;
	},

	collect: function() {
		this.syncGroupServers();
		uci.set('trusttunnel', 'main', 'multi_server', '1');
		uci.set('trusttunnel', 'main', 'mode', 'selective');
		// Если каталог не загрузился (нет сети и нет кэша), чекбоксы не
		// строились и this.checkboxes не определён. Отсутствие данных не
		// значит "ничего не выбрано": без этой проверки Save затирал бы
		// ранее сохранённые lists.source/lists.subnet пустыми массивами
		// каждый раз, когда GitHub недоступен, — молчаливая потеря выбора
		// пользователя из-за временной сетевой проблемы.
		if (!this.checkboxes)
			return;

		var sources = [], subnets = [];
		this.checkboxes.forEach(function(cb) {
			if (!cb.checked) return;
			// Одна отмеченная строка объединённой группы даёт ДВА пути —
			// по одному на семейство адресов.
			var paths = cb.getAttribute('data-path').split(' ').filter(String);
			if (cb.getAttribute('data-kind') === 'subnet')
				subnets.push.apply(subnets, paths);
			else
				sources.push.apply(sources, paths);
		});
		// Пустой список выражается УДАЛЕНИЕМ опции, а не пустым значением.
		// `uci set` с пустым массивом ubus отвергает — проверено прямым
		// вызовом: `{"subnet":[]}` отвечает «Invalid argument». Именно это и
		// ломало сохранение, когда не выбрано ни одной подсети: форма падала
		// с «RPC call to uci/set failed with ubus code 2».
		//
		// Пустая строка здесь безопаснее null по смыслу и делает то же: в
		// uci.js ветка удаления срабатывает на обоих, причём удаление
		// записывается ТОЛЬКО если опция есть в загруженном состоянии, так что
		// на отсутствующей это ничего не отправляет.
		uci.set('trusttunnel', 'lists', 'source', sources.length ? sources : '');
		uci.set('trusttunnel', 'lists', 'subnet', subnets.length ? subnets : '');
	},

	render: function(data) {
		var self = this;
		var geositeCatalog = data[1] || { items: [] };
		var hostHints = data[2] || {};
		var m, s, o;

		m = new form.Map('trusttunnel', _('TrustTunnel'));
		// Каждая секция становится вкладкой. Прецедент в штатных страницах:
		// network/dhcp, network/interfaces, network/routes, system/flash.
		m.tabbed = true;

		// --- Общее -----------------------------------------------------------
		s = m.section(form.NamedSection, 'main', 'main', _('General'));

		o = s.option(form.Flag, 'enabled', _('Start on boot'),
			_('Whether the service starts when the router boots. The Start button on the Status page runs it right now.'));
		o.rmempty = false;

		o = s.option(form.Value, 'health_interval', _('Интервал проверки после ошибки, секунд'));
		o.datatype = 'uinteger'; o.default = '10';

		o = s.option(form.Value, 'stable_health_interval', _('Интервал проверки при стабильной работе, секунд'),
			_('При нормальном соединении используются редкие лёгкие проверки. Замер скорости выполняется отдельно не чаще одного раза в 30 минут.'));
		o.datatype = 'uinteger'; o.default = '300';

		o = s.option(form.Value, 'switch_threshold', _('Порог переключения, мс'));
		o.datatype = 'uinteger'; o.default = '15';

		o = s.option(form.Value, 'switch_cooldown', _('Minimum time between switches, seconds'));
		o.datatype = 'uinteger'; o.default = '120';

		o = s.option(form.Flag, 'device_routing', _('Маршрутизация по устройствам'),
			_('Когда включено, через TrustTunnel идут только группы, назначенные конкретным устройствам. Остальной трафик остаётся прямым.'));
		o.default = '0'; o.rmempty = false;

		o = s.option(form.ListValue, 'log_level', _('Log level'));
		o.value('info', _('Обычный'));
		o.value('debug', _('Отладка'));
		o.value('trace', _('Трассировка'));
		o.description = _('debug and trace write a lot; leave them on only while investigating something.');

		// --- Серверы ---------------------------------------------------------
		s = m.section(form.GridSection, 'server', _('Servers'));
		// A server name is ordinary data, not a UCI section identifier. With
		// named sections LuCI first showed a technical identifier field, so a
		// pasted tt:// link failed with "Expecting: valid UCI identifier" before
		// the import form could even open. Generate the section ID internally.
		s.anonymous = true;
		// Keep the generated identifier when UCI saves the section. Anonymous
		// cfg identifiers are positional and change when older rows are deleted;
		// passwords and group pools need a persistent identifier instead.
		s.handleAdd = function(ev) {
			var id;
			do {
				id = 'srv_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 10);
			} while (uci.get('trusttunnel', id));
			return form.GridSection.prototype.handleAdd.call(this, ev, id);
		};
		s.addremove = true;
		s.addbtntitle = _('Add') + ' ' + _('Server').toLowerCase();
		s.sortable = true;
		s.nodescriptions = true;
		s.sectiontitle = function(sectionID) {
			return uci.get('trusttunnel', sectionID, 'name') || sectionID;
		};
		s.description = _('Only enabled servers are started and checked. With one enabled server it is used directly; with several servers automatic groups choose the fastest healthy one.');

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1'; o.editable = true;
		o = s.option(form.Value, 'name', _('Name')); o.rmempty = false; o.modalonly = true;
		o = s.option(form.Button, '_import', _('Configuration'));
		o.inputtitle = _('Import…'); o.inputstyle = 'action';
		// form.Button calls onclick(event, sectionID). Wrapping handleImport in
		// createHandlerFn here discarded sectionID and passed the click event as
		// the UCI target, so importing into a newly added server could not save
		// any fields. Keep the real GridSection section identifier.
		o.onclick = function(ev, sectionID) { return self.handleImport(sectionID); };
		o.modalonly = true;
		o = s.option(form.DynamicList, 'address', _('Addresses'));
		o.placeholder = '203.0.113.10:443'; o.rmempty = false; o.modalonly = true;
		o = s.option(form.Value, 'hostname', _('TLS host name')); o.rmempty = false; o.modalonly = true;
		o = s.option(form.Value, 'username', _('User name')); o.rmempty = false; o.modalonly = true;
		o = s.option(form.Value, 'password', _('Password'));
		o.password = true; o.rmempty = true; o.modalonly = true; o.placeholder = _('Stored securely; leave blank to keep it');
		o.cfgvalue = function() { return ''; };
		o.write = function(sectionID, value) {
			if (!value) return Promise.resolve();
			return callSecretSet(sectionID, value).then(function(res) {
				if (res && res.error) throw new Error(res.error);
			});
		};
		o.remove = function() {};
		o = s.option(form.ListValue, 'protocol', _('Transport'));
		o.value('http2', 'HTTP/2'); o.value('http3', 'HTTP/3 (QUIC)'); o.default = 'http2'; o.modalonly = true;
		o = s.option(form.Value, 'priority', _('Priority penalty, ms'));
		o.datatype = 'uinteger'; o.default = '0'; o.modalonly = true;
		o = s.option(form.Flag, 'anti_dpi', _('Anti-DPI')); o.default = '0'; o.modalonly = true;
		o = s.option(form.Flag, 'post_quantum', _('Post-quantum key exchange')); o.default = '1'; o.modalonly = true;
		o = s.option(form.Flag, 'has_ipv6', _('Server carries IPv6')); o.default = '1'; o.modalonly = true;
		o = s.option(form.Flag, 'skip_verification', _('Skip certificate verification')); o.default = '0'; o.modalonly = true;
		o = s.option(form.Value, 'custom_sni', _('Custom SNI')); o.modalonly = true;
		o = s.option(form.Value, 'client_random', _('Client random prefix')); o.modalonly = true;
		o = s.option(form.TextValue, 'certificate', _('Pinned certificate (PEM)')); o.rows = 6; o.modalonly = true;
		o = s.option(form.DynamicList, 'dns_upstream', _('DNS used by the client itself')); o.modalonly = true;

		// --- Группы сайтов ---------------------------------------------------
		s = m.section(form.NamedSection, 'lists', 'lists', _('Site groups'));
		s.description = _('Categories from v2fly/domain-list-community, the source used to build geosite.dat. Enable a category and choose automatic server selection or pin it to one server.');

		// Каталог — не поле формы, а произвольная разметка с чекбоксами,
		// поэтому renderWidget подменяется у экземпляра опции: так блок
		// попадает ВНУТРЬ вкладки, а не под форму, где он был бы виден на
		// всех вкладках сразу.
		o = s.option(form.DummyValue, '_catalog', _('Available services'));
		o.renderWidget = L.bind(function() {
			return this.renderGeositeCatalog(geositeCatalog);
		}, this);
		// write и remove ОБЯЗАТЕЛЬНО заглушены. form.DummyValue переопределяет
		// только отрисовку, а запись в UCI наследует от form.Value: сохранение
		// вызывает у каждой опции write() или remove(). Штатный DummyValue
		// прячет значение в скрытое поле, и запись просто возвращает его на
		// место, но здесь отрисовка подменена своей разметкой — скрытого поля
		// нет, formvalue пустой, и уходил `uci set` с пустым аргументом. Форма
		// падала с «RPC call to uci/set failed with ubus code 2: Invalid
		// argument». Плюс сама опция не настройка: `_catalog` не должен
		// появиться в /etc/config/trusttunnel ни при каких условиях.
		o.write = function() {};
		o.remove = function() {};

		o = s.option(form.Flag, 'auto_update', _('Update automatically'),
			_('A cron job refreshes and validates selected lists at 04:17.'));
		o.default = '1';
		o = s.option(form.ListValue, 'update_interval', _('Update interval'));
		o.value('daily', _('Daily')); o.value('weekly', _('Weekly')); o.default = 'daily';
		o.depends('auto_update', '1');

		o = s.option(form.Button, '_update', _('Update now'),
			_('Downloads the selected lists and regenerates the rules immediately. Saved changes are used, so save first.'));
		o.inputtitle = _('Update lists');
		o.inputstyle = 'apply';
		o.onclick = ui.createHandlerFn(this, 'handleUpdateLists');

		o = s.option(form.Button, '_refresh', _('Catalog'),
			_('Downloads the current geosite category index from GitHub.'));
		o.inputtitle = _('Refresh categories');
		o.inputstyle = 'action';
		o.onclick = ui.createHandlerFn(this, 'handleRefreshGeosite');

		// --- Устройства -------------------------------------------------------
		var activeGroups = uci.sections('trusttunnel', 'group').filter(function(g) {
			return g.enabled !== '0';
		});
		s = m.section(form.GridSection, 'device', _('Устройства'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.description = _('Назначьте каждому устройству группы сайтов. Правила начинают действовать после включения маршрутизации по устройствам на вкладке «Общее».');
		s.sectiontitle = function(sectionID) {
			return uci.get('trusttunnel', sectionID, 'name') ||
				uci.get('trusttunnel', sectionID, 'match') || sectionID;
		};

		o = s.option(form.Flag, 'enabled', _('Включено'));
		o.default = '1'; o.editable = true;
		o = s.option(form.Value, 'name', _('Название'));
		o.placeholder = _('Телефон, телевизор или компьютер'); o.rmempty = false; o.modalonly = true;
		o = s.option(form.Value, 'match', _('IP-адрес, подсеть или MAC-адрес'));
		o.placeholder = '192.168.1.20'; o.rmempty = false; o.modalonly = true;
		Object.keys(hostHints).sort().forEach(function(mac) {
			var hint = hostHints[mac] || {};
			var title = hint.name || mac;
			L.toArray(hint.ipaddrs || hint.ipv4).concat(L.toArray(hint.ip6addrs || hint.ipv6)).forEach(function(addr) {
				o.value(addr, title + ' — ' + addr);
			});
			o.value(mac, title + ' — ' + mac);
		});
		o.validate = function(sectionID, value) {
			value = (value || '').trim();
			if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(value)) return true;
			var parts = value.split('/'), addr = parts[0], prefix = parts.length > 1 ? +parts[1] : null;
			if (parts.length > 2) return _('Введите корректный IP-адрес, подсеть или MAC-адрес');
			if (validation.parseIPv4(addr) && (prefix == null || (prefix >= 0 && prefix <= 32))) return true;
			if (validation.parseIPv6(addr) && (prefix == null || (prefix >= 0 && prefix <= 128))) return true;
			return _('Введите корректный IP-адрес, подсеть или MAC-адрес');
		};
		o = s.option(form.MultiValue, 'group', _('Группы сайтов'));
		o.rmempty = true; o.modalonly = true;
		o.write = function(sectionID, value) {
			var groups = L.toArray(value).filter(function(id) { return !!uci.get('trusttunnel', id); });
			uci.set('trusttunnel', sectionID, 'group', groups.length ? groups : '');
		};
		activeGroups.forEach(function(g) {
			o.value(g['.name'], g.name || g['.name']);
		});
		o.description = activeGroups.length
			? _('Можно выбрать несколько групп.')
			: _('Сначала выберите хотя бы одну группу сайтов.');

		// --- Свои домены -----------------------------------------------------
		s = m.section(form.NamedSection, 'domains', 'domains', _('My domains'));
		s.description = _('Your own two lists. They are applied on top of the community lists.');

		o = s.option(form.DynamicList, 'bypass', _('Bypass these'),
			_('Sent through the tunnel in addition to the selected lists. One domain per entry; subdomains are matched automatically.'));
		o.placeholder = 'example.com';
		o.validate = function(section_id, value) {
			if (!value) return true;
			var v = value.toLowerCase();
			// usr/libexec/trusttunnel/normalize отбрасывает голый IPv4 из
			// списка доменов (это данные не того рода) до проверки на
			// синтаксис домена. Без этой же проверки здесь строка вида
			// "192.168.1.1" проходит валидацию формы как "домен" (цифровые
			// метки допустимы синтаксически), сохраняется в UCI, а генератор
			// молча её отбрасывает — пользователь видит "сохранено", но
			// правило никогда не появляется.
			if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(v))
				return _('Not a valid domain name');
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v))
				return _('Not a valid domain name');
			return true;
		};

		o = s.option(form.DynamicList, 'direct', _('Do not bypass these'),
			_('Always sent out directly, even when a community list or a shared CDN address would otherwise route them through the tunnel. Accepts a domain, *.domain, an IP address or a CIDR range.'));
		o.placeholder = 'bank.example';
		o.validate = function(section_id, value) {
			if (!value) return true;
			var v = value.toLowerCase();
			if (/^\*\./.test(v)) v = v.slice(2);
			if (/^[0-9a-f:.\/]+$/.test(v)) return true;
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(v))
				return _('Not a valid domain, IP address or CIDR range');
			return true;
		};

		// --- Сеть ------------------------------------------------------------
		s = m.section(form.NamedSection, 'network', 'network', _('Network'));
		s.description = _('These rarely need changing. MTU is the exception: too high a value makes small pages load while TLS handshakes and large downloads stall.');

		// Поля «устройство TUN» здесь БОЛЬШЕ НЕТ. Имя устройства выбирает сам
		// клиент, а не мы: ключей для его задания в схеме клиента не существует.
		// Оставлять поле означало бы предлагать настройку, которая ни на что не
		// влияет. Фактическое имя показано на странице состояния.
		o = s.option(form.Value, 'mtu', _('MTU'));
		o.datatype = 'range(576,9000)';
		o.default = '1350';

		// Настройки исключений самого клиента. Появились в клиенте 1.1.5;
		// старший их не знает и молча игнорирует — об этом предупреждает
		// диагностика. early-ack включён ВОПРЕКИ дефолту клиента по
		// рекомендации вендора: он нужен, когда DNS резолвит не клиент (наш
		// случай) и для wildcard-записей. На стенде исключение по SNI
		// срабатывало и без него, так что это страховка, а не условие.
		o = s.option(form.Flag, 'early_ack', _('Read the TLS server name before connecting'),
			_('Every TCP connection to the ports below first reveals which site it is for, so a domain from the "do not bypass" list goes out directly even when its address is in the bypass set. The vendor recommends this when DNS is resolved outside the client, as here, and for wildcard entries. Needs TrustTunnel client 1.1.5 or newer.'));
		o.default = '1';

		o = s.option(form.Value, 'scannable_ports', _('Ports inspected for the server name'),
			_('Comma-separated, ranges as 8080:8090. Connections to other ports are never matched against the "do not bypass" list.'));
		o.default = '443,80,8080,8008,853';
		o.placeholder = '443,80,8080,8008,853';
		o.validate = function(section_id, value) {
			if (!value || /^[0-9]+(:[0-9]+)?(,[0-9]+(:[0-9]+)?)*$/.test(value))
				return true;
			return _('Expected ports or ranges separated by commas, e.g. 443,80,8080:8090');
		};

		o = s.option(form.Flag, 'preresolve', _('Pre-resolve "do not bypass" domains'),
			_('The client resolves the excluded domains in the background right after start, so their addresses are known before the first connection.'));
		o.default = '1';

		o = s.option(form.Value, 'preresolve_max', _('Pre-resolve at most'),
			_('Domains per pass. Matters with "everything through VPN" and thousands of excluded domains.'));
		o.datatype = 'uinteger';
		o.default = '50';
		o.depends('preresolve', '1');

		// Буферы TCP-окна внутри туннеля. Дефолт клиента 256 КБ на
		// соединение — заметная величина для роутера с 128 МБ памяти.
		o = s.option(form.Value, 'tcp_recv_buf', _('TCP receive buffer, bytes'),
			_('Per connection inside the tunnel. 0 means the client default of 256 KB; lower it on routers with little memory, at the cost of throughput.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = s.option(form.Value, 'tcp_send_buf', _('TCP send buffer, bytes'),
			_('Per connection inside the tunnel. 0 means the client default of 256 KB.'));
		o.datatype = 'uinteger';
		o.default = '0';

		o = s.option(form.Value, 'lan_devices', _('LAN interfaces'),
			_('Space-separated list whose forwarded traffic is considered. Empty means the device of the lan network.'));
		o.placeholder = 'br-lan';
		o.optional = true;

		o = s.option(form.Flag, 'blackhole_on_down', _('Drop traffic when the tunnel is down'),
			_('Adds a blackhole route so marked traffic is dropped instead of leaking to the provider.'));
		o.default = '1';

		o = s.option(form.Flag, 'include_router_traffic', _('Route the router\'s own traffic too'),
			_('By default only forwarded LAN traffic is routed. Enabling this also routes traffic originated by the router itself, including list updates and the update check.'));
		// Один селектор вместо прежней пары «флаг + адрес». Флаг «резолвить
		// через туннель» и тип резолвера могли противоречить друг другу — это
		// та же путаница, из-за которой два поля DNS приходилось разводить
		// описаниями. Теперь режим один, и от него зависит, какие поля видны.
		//
		// Межсекционный depends() в form.js не поддерживается, поэтому
		// применимость к режиму «обход по списку» указана в описании.
		// Генераторы эти опции в режиме «всё через VPN» игнорируют.
		o = s.option(form.ListValue, 'list_dns', _('DNS for domains from the lists'),
			_('Applies in "bypass by list" mode only. Who resolves the domains from your lists, and how the query is protected.'));
		o.value('plain', _('Plain DNS through the tunnel — the query is hidden by the tunnel itself'));
		// «Локальный прокси» из этой подписи убран: при флаге «ко всей сети»
		// своего инстанса нет вовсе, работает штатный https-dns-proxy.
		o.value('doh', _('Encrypted DNS over HTTPS — the query goes out encrypted, directly'));
		o.value('provider', _('Whatever the router already uses — usually the provider'));
		o.default = 'plain';

		o = s.option(form.Value, 'list_resolver', _('Plain resolver address'),
			// Честно про ограничение: значение уходит в директиву dnsmasq
			// `server=/домен/адрес`, а она принимает только обычный адрес.
			// Защита устроена иначе, и это стоит сказать: адрес резолвера
			// помещается в набор обхода (gen-lists), поэтому запрос идёт
			// ВНУТРИ туннеля, и провайдер не видит его и не может подменить.
			_('This address is placed in the bypass set, so the query travels inside the tunnel and the provider can neither read nor spoof it. A port may be added after #.'));
		// НЕ datatype='ipaddr': директива dnsmasq принимает `адрес#порт`, и без
		// порта нельзя указать локальный прокси, который слушает не на 53.
		o.default = '1.1.1.1';
		o.depends('list_dns', 'plain');
		o.validate = function(section_id, value) {
			if (!value) return true;
			var host = value, port = null, hash = value.indexOf('#');
			if (hash >= 0) {
				host = value.slice(0, hash);
				port = value.slice(hash + 1);
				if (!/^[0-9]{1,5}$/.test(port) || +port < 1 || +port > 65535)
					return _('The port after # must be between 1 and 65535');
			}
			// Проверка адреса средствами LuCI, чтобы не заводить свой разбор
			// IPv4 и IPv6.
			if (!validation.parseIPv4(host) && !validation.parseIPv6(host))
				return _('Enter an IP address, optionally followed by #port');
			return true;
		};
		o.value('1.1.1.1', 'Cloudflare');
		o.value('9.9.9.9', 'Quad9');
		o.value('8.8.8.8', 'Google');
		o.value('94.140.14.14', 'AdGuard');

		o = s.option(form.Value, 'list_doh_url', _('DoH resolver URL'),
			_('The resolver itself. Whether it serves only the domains from your lists or the whole network is decided by the checkbox below. The query leaves encrypted, but directly — not through the tunnel. For NextDNS with your own profile use https://dns.nextdns.io/<your-id>. Requires the https-dns-proxy package; without it the list domains fall back to the provider resolver and Diagnostics says so.'));
		o.depends('list_dns', 'doh');
		o.placeholder = 'https://dns.quad9.net/dns-query';
		o.value('https://dns.quad9.net/dns-query', 'Quad9');
		o.value('https://cloudflare-dns.com/dns-query', 'Cloudflare');
		o.value('https://dns.adguard-dns.com/dns-query', 'AdGuard');
		o.validate = function(section_id, value) {
			if (!value) return true;
			// Только https: сам смысл настройки в шифровании, и http здесь
			// был бы обманом ожидания.
			if (!/^https:\/\/[^\s]+$/.test(value))
				return _('Enter an https:// URL');
			return true;
		};

		// Флаг, из-за которого разрыв «задал, а не действует» вообще закрылся.
		// Резолвер выше обслуживал ТОЛЬКО домены из списков, а весь остальной
		// DNS сети шёл туда, куда его направил штатный https-dns-proxy: любая
		// проверялка в списках не лежит и показывала чужой резолвер, отчего
		// настройка выглядела неработающей.
		//
		// Своим снипетом в conf-dir общий DNS не забрать — проверено на живом
		// роутере: wildcard-домен `/#/` приоритета над бездоменными `server=`
		// не имеет и попадает с ними в один пул. Поэтому служба переводит на
		// этот URL штатный https-dns-proxy и возвращает его настройки при
		// остановке.
		o = s.option(form.Flag, 'doh_network', _('Use this resolver for the whole network'),
			_('While the service is running, every query from the router and its clients goes to this resolver: the service switches the stock https-dns-proxy over to it and restores its settings when stopped. Two consequences worth knowing before you turn this on. dnsmasq is restarted when the service starts and stops, so the network loses DNS for a fraction of a second. And if this resolver stops answering, the whole network is left without DNS, not just the domains from the lists.'));
		o.depends('list_dns', 'doh');
		o.default = '0';

		o = s.option(form.Value, 'list_doh_port', _('Local port for the proxy'),
			// Порт настраиваемый, а не зашитый: 5053 занимает пакетный init
			// https-dns-proxy, 5453 — stubby, и при конфликте иначе было бы
			// нечем разойтись.
			_('The local proxy listens on 127.0.0.1 at this port. Change it only if something else on the router already uses it.'));
		// Скрыто, когда резолвер обслуживает всю сеть: своего инстанса в этом
		// режиме нет вовсе — работает штатный https-dns-proxy на своих портах,
		// — и задавать порт было бы нечему.
		o.depends({ list_dns: 'doh', doh_network: '0' });
		o.default = '5460';
		o.datatype = 'port';

		o = s.option(form.Flag, 'intercept_dns', _('Intercept client DNS'),
			_('Applies in "bypass by list" mode only. Redirects port 53 to the router and blocks 853. Without it a device using its own DoH resolver bypasses the list matching.'));

		// Метка идёт прямо в `ip rule add fwmark …`, поэтому формат проверяем
		// здесь: без проверки мусорное значение доходит до ядра, `ip rule`
		// падает, а его stderr никуда не всплывает — маршрутизация остаётся
		// собранной наполовину и молча.
		o = s.option(form.Value, 'fwmark', _('Firewall mark'),
			_('Decimal or 0x-prefixed hexadecimal. Change only on a conflict with mwan3, SQM or another package that marks packets.'));
		o.default = '0x9527';
		o.validate = function(section_id, value) {
			if (!value) return true;
			if (!/^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value))
				return _('Enter a decimal number or 0x-prefixed hexadecimal');
			// Ограничение на число цифр (до 10) само по себе не отсекает
			// значение, превышающее 32-битный максимум: "9999999999" проходит
			// эту проверку по форме, хотя fwmark — 32-битное поле в ядре.
			if (!/^0x/i.test(value) && +value > 4294967295)
				return _('Enter a decimal number no greater than 4294967295');
			return true;
		};

		// НЕ range(1,252). Идентификатор таблицы маршрутизации в Linux
		// 32-битный, и значение по умолчанию 880 выбрано именно чтобы не
		// пересекаться с диапазоном, который занимают другие пакеты.
		// Проверено на живом OpenWrt: ядро принимает и 880, и 900.
		// Ограничение 1..252 отвергало бы штатную конфигурацию, то есть
		// страницу настроек нельзя было бы сохранить из коробки.
		// Исключаются только 0 и 253..255 — это main, default и local,
		// перехват которых сломал бы маршрутизацию всей системы.
		o = s.option(form.Value, 'table', _('Routing table'),
			_('Any table id except 0 and the reserved 253-255.'));
		o.datatype = 'uinteger';
		o.default = '880';
		o.validate = function(section_id, value) {
			if (!value) return true;
			var n = +value;
			if (!/^[0-9]+$/.test(value) || n < 1 || n > 4294967294)
				return _('Enter a table id between 1 and 4294967294');
			if (n >= 253 && n <= 255)
				return _('Table ids 253, 254 and 255 are reserved by the system');
			return true;
		};

		return m.render();
	}
});
