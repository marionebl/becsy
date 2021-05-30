import {System, World} from '../src';

let message: string;

class SystemA extends System {
  message: string;
  execute() {
    message = this.message;
  }
}

class SystemB extends System {
  systemA = this.attach(SystemA);
  execute() {
    this.systemA.message = 'hello';
  }
}


describe('attaching systems', () => {

  test('attach a system', async() => {
    const world = await World.create({defs: [SystemB, SystemA, {message: 'hello'}]});
    await world.execute();
    expect(message).toBe('hello');
  });

});
