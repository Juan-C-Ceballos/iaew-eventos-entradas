// Genera carga/plan-carga.jmx, el plan de JMeter de la prueba de carga. Se escribe como código porque el
// XML de JMeter es muy repetitivo y así cada sampler se define en una línea. El .jmx generado se commitea:
// se puede abrir en JMeter o correr con carga/ejecutar.js sin ejecutar este archivo.
//
//   node carga/generar-plan.js
//
// Escenario de un canal de venta, repetido por cada hilo durante la duración indicada:
//   GET /eventos → GET /eventos/{id} → POST /compras (Idempotency-Key única) → GET /compras/{id}
//   → en ~30% de las iteraciones, POST /compras/{id}/pagar (dispara el webhook y la emisión asincrónica)
// Parámetros (-J en JMeter): host, port, protocolo, token, eventoId, hilos, rampa, duracion.
const fs = require('node:fs');
const path = require('node:path');

const esc = (texto) => String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const variable = (nombre, valor, comentario = '') => `
          <elementProp name="${nombre}" elementType="Argument">
            <stringProp name="Argument.name">${nombre}</stringProp>
            <stringProp name="Argument.value">${esc(valor)}</stringProp>
            <stringProp name="Argument.metadata">=</stringProp>${comentario ? `\n            <stringProp name="Argument.desc">${esc(comentario)}</stringProp>` : ''}
          </elementProp>`;

const encabezados = (nombre, pares) => `
        <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="${esc(nombre)}" enabled="true">
          <collectionProp name="HeaderManager.headers">${Object.entries(pares).map(([k, v]) => `
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">${esc(k)}</stringProp>
              <stringProp name="Header.value">${esc(v)}</stringProp>
            </elementProp>`).join('')}
          </collectionProp>
        </HeaderManager>
        <hashTree/>`;

const aserCodigo = (codigo) => `
          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="HTTP ${codigo}" enabled="true">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="${codigo}">${codigo}</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">8</intProp>
          </ResponseAssertion>
          <hashTree/>`;

const extractor = (referencia, expresion) => `
          <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="${esc(referencia)}" enabled="true">
            <stringProp name="JSONPostProcessor.referenceNames">${referencia}</stringProp>
            <stringProp name="JSONPostProcessor.jsonPathExprs">${esc(expresion)}</stringProp>
            <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
            <stringProp name="JSONPostProcessor.defaultValues">SIN_${referencia.toUpperCase()}</stringProp>
          </JSONPostProcessor>
          <hashTree/>`;

function sampler({ nombre, metodo = 'GET', ruta, cuerpo, esperado, cabeceras, extraer }) {
  const argumentos = cuerpo === undefined ? `
        <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
          <collectionProp name="Arguments.arguments"/>
        </elementProp>` : `
        <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
        <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
          <collectionProp name="Arguments.arguments">
            <elementProp name="" elementType="HTTPArgument">
              <boolProp name="HTTPArgument.always_encode">false</boolProp>
              <stringProp name="Argument.value">${esc(cuerpo)}</stringProp>
              <stringProp name="Argument.metadata">=</stringProp>
            </elementProp>
          </collectionProp>
        </elementProp>`;
  return `
      <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${esc(nombre)}" enabled="true">${argumentos}
        <stringProp name="HTTPSampler.domain">\${host}</stringProp>
        <stringProp name="HTTPSampler.port">\${port}</stringProp>
        <stringProp name="HTTPSampler.protocol">\${protocolo}</stringProp>
        <stringProp name="HTTPSampler.path">${esc(ruta)}</stringProp>
        <stringProp name="HTTPSampler.method">${metodo}</stringProp>
        <boolProp name="HTTPSampler.follow_redirects">false</boolProp>
        <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
        <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
        <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>
        <stringProp name="HTTPSampler.connect_timeout">5000</stringProp>
        <stringProp name="HTTPSampler.response_timeout">30000</stringProp>
      </HTTPSamplerProxy>
      <hashTree>${cabeceras ? encabezados(`Cabeceras de ${nombre}`, cabeceras) : ''}${aserCodigo(esperado)}${extraer ? extractor(extraer[0], extraer[1]) : ''}
      </hashTree>`;
}

const CUERPO_COMPRA = '{"eventoId":"${eventoId}","cantidad":1,"asistente":{"nombre":"Carga Test","email":"carga@example.com","documento":"${__RandomString(8,0123456789,)}"}}';

const muestras = [
  sampler({ nombre: 'GET /eventos', ruta: '/eventos', esperado: 200 }),
  sampler({ nombre: 'GET /eventos/{id}', ruta: '/eventos/${eventoId}', esperado: 200 }),
  sampler({ nombre: 'POST /compras', metodo: 'POST', ruta: '/compras', cuerpo: CUERPO_COMPRA, esperado: 201, cabeceras: { 'Idempotency-Key': 'carga:${__UUID()}' }, extraer: ['compraId', '$.compra._id'] }),
  sampler({ nombre: 'GET /compras/{id}', ruta: '/compras/${compraId}', esperado: 200 }),
  // ~30% de las iteraciones pagan: ejercita pasarela, webhook, outbox, RabbitMQ y worker bajo carga.
  `
      <IfController guiclass="IfControllerPanel" testclass="IfController" testname="El 30% paga" enabled="true">
        <stringProp name="IfController.condition">\${__jexl3(\${__Random(1,10)} &lt;= 3,)}</stringProp>
        <boolProp name="IfController.evaluateAll">false</boolProp>
        <boolProp name="IfController.useExpression">true</boolProp>
      </IfController>
      <hashTree>${sampler({ nombre: 'POST /compras/{id}/pagar', metodo: 'POST', ruta: '/compras/${compraId}/pagar', cuerpo: '{"escenario":"aprobado"}', esperado: 202, cabeceras: { 'Idempotency-Key': 'carga-pago:${__UUID()}' } })}
      </hashTree>`
].join('');

const plan = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.5">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="IAEW 2026 - Eventos y Entradas: prueba de carga" enabled="true">
      <stringProp name="TestPlan.comments">Canal de venta: lista y consulta eventos, reserva (Idempotency-Key única) y paga una parte de las compras. Se corre con carga/ejecutar.js.</stringProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="Parámetros" enabled="true">
        <collectionProp name="Arguments.arguments">${[
          variable('host', '${__P(host,localhost)}', 'Host de la API'),
          variable('port', '${__P(port,3000)}'),
          variable('protocolo', '${__P(protocolo,http)}'),
          variable('token', '${__P(token,)}', 'Access token del canal de venta (buy:entradas). Se reutiliza en toda la prueba: un token por request agotaría el cupo de Auth0.'),
          variable('eventoId', '${__P(eventoId,66f000000000000000000001)}', 'Evento con capacidad de sobra (lo crea carga/ejecutar.js)'),
          variable('hilos', '${__P(hilos,20)}'),
          variable('rampa', '${__P(rampa,10)}', 'Segundos hasta tener todos los hilos activos'),
          variable('duracion', '${__P(duracion,60)}', 'Segundos de la prueba')
        ].join('')}
        </collectionProp>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="Canal de venta" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <intProp name="LoopController.loops">-1</intProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${hilos}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">\${rampa}</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">\${duracion}</stringProp>
        <stringProp name="ThreadGroup.delay"></stringProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
      </ThreadGroup>
      <hashTree>${encabezados('Cabeceras comunes', { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json', Accept: 'application/json' })}
        <UniformRandomTimer guiclass="UniformRandomTimerGui" testclass="UniformRandomTimer" testname="Tiempo de espera del cliente (100-400 ms)" enabled="true">
          <stringProp name="ConstantTimer.delay">100</stringProp>
          <stringProp name="RandomTimer.range">300</stringProp>
        </UniformRandomTimer>
        <hashTree/>${muestras}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;

// CARGA_DESTINO permite generar en otra carpeta (los tests comparan el resultado con lo commiteado).
fs.writeFileSync(path.join(process.env.CARGA_DESTINO || __dirname, 'plan-carga.jmx'), plan);
console.log(`plan-carga.jmx generado (${plan.length} bytes)`);
