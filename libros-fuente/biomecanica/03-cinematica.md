# Capítulo 3. Cinemática: describir el movimiento

## Describir sin preguntar por las causas

La **cinemática** es la parte de la mecánica que describe cómo se mueve un cuerpo sin preguntarse qué fuerzas lo mueven. Es el equivalente a ver una película del movimiento y tomar notas: dónde estaba el segmento, qué tan rápido se desplazó, cuánto cambió su velocidad. Es una herramienta fundamental en la clínica porque lo primero que observas en un paciente es movimiento: cuánto flexiona la rodilla al caminar, qué tan rápido se levanta de una silla, cuánta rotación tiene el tronco al alcanzar un objeto.

Las tres magnitudes centrales son la posición, la velocidad y la aceleración. Cada una resulta de la anterior al preguntar «¿cómo cambia con el tiempo?». La velocidad es el cambio de posición por unidad de tiempo; la aceleración, el cambio de velocidad por unidad de tiempo.

## Posición y desplazamiento

La **posición** indica dónde está un punto respecto de un sistema de referencia. Siempre necesitas decir *respecto de qué*. La posición del tobillo puede medirse respecto del suelo, de la cadera o de otra marca del laboratorio, y los valores serán distintos. El **desplazamiento** es el cambio de posición y es un vector: tiene magnitud y dirección. La **distancia recorrida**, en cambio, es la longitud total del trayecto y es un escalar.

Si caminas 10 m hacia adelante y 10 m de regreso, tu distancia recorrida es 20 m, pero tu desplazamiento neto es cero. Esta diferencia parece un detalle, pero evita confusiones al interpretar pruebas funcionales: en una prueba de caminata de seis minutos, lo que se registra es la distancia recorrida, no el desplazamiento.

## Velocidad

La **velocidad media** es el desplazamiento dividido entre el tiempo transcurrido:

Velocidad = desplazamiento / tiempo

Se mide en metros por segundo (m/s). Una persona adulta sana camina, en promedio, a una velocidad del orden de 1.2 a 1.4 m/s en terreno plano y a su ritmo habitual, aunque hay variaciones por edad, estatura y condición. Con 1.4 m/s, recorrer 100 m toma 100 / 1.4 = 71.4 s, aproximadamente 71 segundos.

Recuerda la equivalencia práctica: 1 m/s equivale a 3.6 km/h. Entonces 1.4 m/s son 5.04 km/h. Esta conversión sirve para traducir a un lenguaje cotidiano las velocidades de marcha que mides en consulta con un cronómetro y una distancia marcada en el piso. Por ejemplo, un paciente que recorre 10 metros en 12.5 segundos camina a 0.8 m/s, es decir, unos 2.9 km/h.

La **velocidad instantánea** es la que tiene el cuerpo en un momento específico. Es lo que marca el velocímetro de un coche, y en clínica la proporcionan los sensores o el análisis de video. La velocidad también es un vector: indica a qué rapidez y en qué dirección se mueve.

## Aceleración

La **aceleración** es el cambio de la velocidad por unidad de tiempo:

Aceleración = cambio de velocidad / tiempo

Se mide en m/s². Si un corredor pasa de 0 a 6 m/s en 3 segundos, su aceleración media es 6 / 3 = 2 m/s². Esto significa que su velocidad aumenta 2 m/s cada segundo.

La aceleración también ocurre cuando cambia la dirección del movimiento, aunque la rapidez permanezca constante. Un pie que describe una curva al balancearse durante la marcha experimenta aceleración en todo momento. Una aceleración negativa (frenado) se llama desaceleración, aunque en física sigue siendo simplemente una aceleración con signo contrario al de la velocidad.

Hay un caso especial muy conocido: la **caída libre**, donde la única fuerza que actúa es el peso y la aceleración es la de la gravedad, aproximadamente 9.8 m/s² hacia abajo. Si dejas caer un objeto desde el reposo, su velocidad al cabo de un tiempo t es 9.8 x t. Tras 0.5 s alcanza 4.9 m/s, y en ese tiempo habrá descendido 0.5 x 9.8 x 0.5² = 1.225 m, es decir, unos 1.2 metros. Esta idea sirve para estimar con qué velocidad toca el suelo alguien que salta o se cae desde una altura conocida.

## Movimiento con aceleración constante

Cuando la aceleración es constante, tres fórmulas resumen el comportamiento:

- Velocidad final = velocidad inicial + aceleración x tiempo.
- Desplazamiento = velocidad inicial x tiempo + ½ x aceleración x tiempo².
- Velocidad final² = velocidad inicial² + 2 x aceleración x desplazamiento.

Veamos un ejemplo de la tercera. Una persona salta desde un escalón de 0.30 m de altura. ¿Con qué velocidad llega al suelo? Parte del reposo, la aceleración es 9.8 m/s² y el desplazamiento es 0.30 m. Velocidad² = 0 + 2 x 9.8 x 0.30 = 5.88, así que la velocidad es la raíz cuadrada de 5.88, aproximadamente 2.4 m/s. Ese dato nos servirá en el capítulo 4 para estimar las fuerzas de aterrizaje.

Estas fórmulas valen mientras la aceleración sea constante, lo cual es una buena aproximación en caídas y lanzamientos, pero no en la mayoría de los gestos humanos, donde los músculos modifican la fuerza a cada instante. En esos casos se usan registros de posición o velocidad en el tiempo y se calculan las aceleraciones de punto a punto.

## Movimiento angular

Casi todos los movimientos de las articulaciones son rotaciones. Por eso necesitamos un conjunto paralelo de magnitudes angulares.

- **Posición angular** (θ): el ángulo que forma un segmento respecto de una referencia. Se mide en grados o radianes. Una flexión de codo de 0° a 140° tiene un desplazamiento angular de 140°.
- **Velocidad angular** (ω): la rapidez con la que cambia el ángulo. Se expresa en grados por segundo o en radianes por segundo.
- **Aceleración angular** (α): el cambio de la velocidad angular por unidad de tiempo.

Ejemplo: un paciente flexiona el codo desde 0° hasta 90° en 0.5 s. La velocidad angular media es 90 / 0.5 = 180° por segundo. En radianes, 90° equivalen a 1.571 rad, así que ω = 1.571 / 0.5 = 3.14 rad/s. Ambas cifras describen exactamente lo mismo.

Una relación valiosa conecta lo angular con lo lineal. Un punto situado a una distancia r del eje de giro se mueve con una velocidad lineal tangencial:

Velocidad tangencial = velocidad angular (en rad/s) x radio

Si la mano está a 0.6 m del hombro y el brazo gira a 3.14 rad/s, la velocidad de la mano es 3.14 x 0.6 = 1.88 m/s. Un punto más lejano del eje se mueve más rápido con la misma velocidad angular. Esta es la razón por la que el extremo de un palo de golf, un bate o una raqueta alcanza velocidades altas con una rotación articular moderada, y por la que la mano se mueve más rápido que el codo cuando lanzas.

> Nota clínica: cuando mides un rango de movimiento con goniómetro, estás midiendo una posición angular. Cuando le pides al paciente que lo haga más rápido, estás cambiando la velocidad angular, y es probable que también cambie el patrón de reclutamiento muscular.

## Trayectorias y planos de movimiento

La **trayectoria** es la línea que describe un punto al moverse. La trayectoria de la mano al llevar un vaso a la boca es curva, no recta, y el cerebro la planifica de forma que sea eficiente y suave. Las trayectorias nos dicen si un movimiento es fluido o presenta interrupciones. Un temblor, una compensación o una corrección tardía se manifiestan como irregularidades en la trayectoria o en la velocidad.

Un concepto relacionado es el **centro instantáneo de rotación**: el punto alrededor del cual, en un instante dado, parece girar el segmento. En una articulación ideal tipo bisagra, ese punto permanece fijo. En la rodilla real, el centro se desplaza a medida que el fémur rueda y desliza sobre la tibia, así que la mecánica no puede reducirse a una bisagra perfecta, aunque lo hagamos para simplificar.

## Rodamiento y deslizamiento articular

Los movimientos articulares combinan **rodamiento** (superficies que ruedan una sobre otra, como un neumático sobre la calle) y **deslizamiento** (una superficie se desplaza sobre la otra sin cambiar de punto de contacto, como un neumático patinando). Si una articulación solo rodara, el hueso que gira se saldría de la superficie opuesta. Si solo deslizara, el movimiento sería limitado. El movimiento normal es una mezcla en la que predominan ciertos componentes según el ángulo.

Este concepto es la base de muchas técnicas de movilización articular, que parten de la idea de que la restricción del deslizamiento puede limitar el rango final. Sin entrar en técnicas específicas, lo relevante es entender que el movimiento de un hueso en el espacio (movimiento osteocinemático, lo que medimos con goniómetro) y el movimiento de las superficies articulares entre sí (artrocinemático) son dos niveles de descripción distintos.

## Cadenas cinemáticas abiertas y cerradas

Hablamos de **cadena cinemática abierta** cuando el extremo distal del segmento se mueve libremente en el espacio, como cuando extiendes la rodilla sentado con el pie en el aire. En una **cadena cerrada**, el extremo distal está fijo o apoyado contra una superficie, como en una sentadilla con los pies en el suelo. En la cadena cerrada, el movimiento de una articulación obliga a las vecinas a moverse de manera coordinada: si flexionas la rodilla en una sentadilla, tobillo y cadera también se flexionan.

Esta clasificación es útil para describir ejercicios, pero no es una división rígida ni implica por sí misma que una modalidad sea «más segura» o «más funcional». Cada una produce patrones de carga distintos y la elección depende del objetivo y del estado del tejido.

## Medir el movimiento

Existen varias maneras de medir cinemática, de la más sencilla a la más sofisticada.

- **Goniómetro**: mide ángulos articulares. Es económico y práctico, con una fiabilidad razonable si se estandariza el procedimiento.
- **Cronómetro y cinta métrica**: permiten calcular velocidades de marcha y tiempos de pruebas funcionales.
- **Video con aplicaciones de análisis**: permiten medir ángulos y tiempos cuadro a cuadro; su precisión depende de la posición de la cámara y del cuidado al marcar los puntos.
- **Sensores inerciales**: dispositivos pequeños con acelerómetros y giroscopios que se colocan sobre los segmentos.
- **Captura de movimiento con marcadores**: sistemas de laboratorio con cámaras infrarrojas que reconstruyen la posición tridimensional de los puntos.

Un consejo práctico: para fines clínicos, la consistencia importa más que la sofisticación. Si mides siempre en la misma posición, con la misma referencia y las mismas indicaciones, tus comparaciones antes y después serán confiables aunque uses un instrumento sencillo.

## ¿Por qué le importa esto al fisioterapeuta?

Considera a un paciente que se recupera de una fractura de muñeca y presenta limitación de la flexión. Si mides 40° al inicio y 55° tras cuatro semanas, tienes una variable cinemática objetiva que documenta el avance y que puedes compartir con el médico y con el propio paciente. Esto es motivador y ordena la toma de decisiones.

En otro escenario, un adulto mayor tarda 14 segundos en recorrer una distancia de 10 m, es decir, camina a unos 0.7 m/s. Esa cifra te ayuda a identificar que su marcha está lenta, que puede tener implicaciones funcionales, y a seguir su evolución con un criterio simple. La velocidad de marcha se considera un indicador funcional útil en la literatura clínica, aunque debes interpretarla junto con el resto de la valoración.

También te ayuda a razonar sobre ejercicio. Si pides a un paciente que baje lentamente de un escalón, la aceleración es pequeña y el control excéntrico del cuádriceps es la clave; si baja de golpe, la velocidad de llegada es mayor y las fuerzas de impacto aumentan. Mirar la velocidad y la aceleración te da un lenguaje para modificar la dificultad sin cambiar la carga externa.

## Ideas clave

- La cinemática describe el movimiento (posición, velocidad, aceleración) sin considerar sus causas.
- El desplazamiento es un vector; la distancia recorrida es un escalar.
- La velocidad de marcha habitual de un adulto sano es del orden de 1.2 a 1.4 m/s, y 1 m/s equivale a 3.6 km/h.
- La caída libre tiene una aceleración aproximada de 9.8 m/s²; la velocidad de llegada tras caer desde una altura h es la raíz de 2 x 9.8 x h.
- Los movimientos articulares son rotaciones; se describen con posición, velocidad y aceleración angulares.
- La velocidad tangencial es la velocidad angular (en rad/s) por el radio, de modo que los puntos distales se mueven más rápido.
- El movimiento articular combina rodamiento y deslizamiento; hay que diferenciar lo osteocinemático de lo artrocinemático.
- Para la clínica, medir de forma consistente es más importante que usar equipos complejos.

## Preguntas para reflexionar

1. Un paciente recorre 8 metros en 10 segundos. ¿Cuál es su velocidad media en m/s y en km/h?
2. Un paciente salta desde un escalón de 0.20 m. Calcula con qué velocidad llega al suelo y explica por qué es útil conocer ese dato.
3. ¿Qué diferencia hay entre medir la flexión de rodilla con goniómetro y describir cómo se deslizan el fémur y la tibia?
4. Si un brazo gira a 2 rad/s y la mano está a 0.5 m del hombro, ¿cuál es la velocidad lineal de la mano? ¿Qué pasaría si sostuvieras una herramienta de 0.3 m más?
5. Menciona un ejemplo de ejercicio en cadena abierta y otro en cadena cerrada para la misma articulación, y describe una diferencia en lo que cada uno pide al cuerpo.
